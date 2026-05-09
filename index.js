const { Client } = require("@notion/client");
const { chromium } = require("playwright");
require("dotenv").config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Configuración de búsqueda
const SEARCH_QUERY = process.env.SEARCH_QUERY || "Fisioterapia Barcelona";
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS) || 10;

// User-Agent común para evitar bloqueos básicos
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function scrapeGoogleMaps() {
  console.log(`[${new Date().toISOString()}] Iniciando scraper para: "${SEARCH_QUERY}"`);
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 }
  });
  
  const page = await context.newPage();
  const leads = [];

  try {
    console.log(`Navigando a Google Maps...`);
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(SEARCH_QUERY)}`, {
      waitUntil: 'networkidle'
    });

    // Manejar diálogo de cookies (más robusto)
    try {
      const cookieButtons = [
        'button:has-text("Aceptar todo")', 
        'button:has-text("Accept all")',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Tout accepter")'
      ];
      
      for (const selector of cookieButtons) {
        if (await page.locator(selector).isVisible()) {
          await page.click(selector);
          console.log("Cookies aceptadas.");
          break;
        }
      }
    } catch (e) {
      console.log("No se pudo detectar o cerrar el diálogo de cookies (puede que no apareciera).");
    }

    await page.waitForTimeout(2000);

    // Verificar si nos redirigió directamente a un sitio o si hay lista
    const isSingleResult = await page.url().includes('/maps/place/');

    if (isSingleResult) {
      console.log("Resultado único detectado. Procesando directamente...");
      const lead = await extractBusinessData(page);
      if (lead) leads.push(lead);
    } else {
      console.log("Lista de resultados detectada.");
      // Esperar a que cargue el feed de resultados
      try {
        await page.waitForSelector('div[role="feed"]', { timeout: 10000 });
      } catch (e) {
        console.log("Aviso: No se encontró div[role='feed'], intentando continuar...");
      }

      // Scroll para cargar resultados
      for (let i = 0; i < 3; i++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(1500);
      }

      const resultItems = await page.$$('a[href*="/maps/place/"]');
      console.log(`Encontrados ${resultItems.length} posibles resultados.`);

      for (let i = 0; i < Math.min(resultItems.length, MAX_RESULTS); i++) {
        try {
          const item = resultItems[i];
          await item.click();
          await page.waitForTimeout(1500); // Esperar a que cargue el detalle

          const lead = await extractBusinessData(page);
          if (lead) {
            leads.push(lead);
            console.log(`[${i+1}/${MAX_RESULTS}] Procesado: ${lead.name}`);
          }
        } catch (e) {
          console.error(`Error procesando resultado ${i}:`, e.message);
        }
      }
    }

    // Buscar Instagram para cada lead usando la misma instancia de navegador
    console.log("Buscando enlaces de Instagram...");
    for (let lead of leads) {
      if (lead.website) {
        lead.instagram = await findInstagramLink(context, lead.website);
      }
    }

  } catch (error) {
    console.error("Error durante el scraping:", error);
  } finally {
    await browser.close();
  }

  return leads;
}

async function extractBusinessData(page) {
  try {
    const name = await page.innerText('h1');
    const website = await page.getAttribute('a[data-item-id="authority"]', 'href').catch(() => null);
    
    // Selector de teléfono más genérico o alternativo
    let phone = null;
    try {
      phone = await page.getAttribute('button[data-tooltip*="teléfono"]', 'aria-label') || 
              await page.getAttribute('button[data-tooltip*="phone"]', 'aria-label');
      
      if (phone) {
        phone = phone.replace(/.*: /, "").trim();
      }
    } catch (e) {}

    return {
      name,
      website,
      phone,
      source: "Google Maps"
    };
  } catch (e) {
    console.error("Error extrayendo datos del negocio:", e.message);
    return null;
  }
}

async function findInstagramLink(context, url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { timeout: 15000, waitUntil: 'load' });
    const igLink = await page.getAttribute('a[href*="instagram.com"]', 'href').catch(() => null);
    await page.close();
    return igLink;
  } catch (e) {
    await page.close();
    return null;
  }
}

async function syncToNotion(leads) {
  if (leads.length === 0) {
    console.log("No hay leads para sincronizar.");
    return;
  }

  console.log(`Sincronizando ${leads.length} leads con Notion...`);

  for (const lead of leads) {
    try {
      const whatsapp = lead.phone ? `https://wa.me/${lead.phone.replace(/[^0-9]/g, '')}?text=Hola!%20Hemos%20visto%20tu%20perfil%20en%20Google%20Maps%20y%20nos%20ha%20parecido%20muy%20interesante%20vuestro%20centro...` : null;

      await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: {
          "Nombre": { title: [{ text: { content: lead.name } }] },
          "Estado": { status: { name: "Inbox" } },
          "Instagram": { url: lead.instagram || null },
          "WhatsApp": { url: whatsapp || null },
          "Web": { url: lead.website || null },
          "Teléfono": { phone_number: lead.phone || null },
          "Fuente": { select: { name: lead.source } },
          "Fecha de Captura": { date: { start: new Date().toISOString().split('T')[0] } }
        }
      });
      console.log(`Sincronizado: ${lead.name}`);
    } catch (e) {
      console.error(`Error al subir a Notion: ${lead.name}`, e.message);
    }
  }
}

(async () => {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    console.error("ERROR: Faltan variables de entorno NOTION_TOKEN o NOTION_DATABASE_ID");
    process.exit(1);
  }

  try {
    const leads = await scrapeGoogleMaps();
    await syncToNotion(leads);
    console.log("¡Proceso completado con éxito!");
  } catch (e) {
    console.error("Error crítico en la ejecución:", e);
    process.exit(1);
  }
})();


