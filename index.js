const { Client } = require("@notion-hq/client");
const { chromium } = require("playwright");
require("dotenv").config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Configuración de búsqueda
const SEARCH_QUERY = process.env.SEARCH_QUERY || "Fisioterapia Barcelona";
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS) || 10;

async function scrapeGoogleMaps() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Buscando en Google Maps: "${SEARCH_QUERY}"...`);
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(SEARCH_QUERY)}`);

  // Aceptar cookies si aparece el diálogo
  try {
    await page.click('button:has-text("Aceptar todo")', { timeout: 5000 });
  } catch (e) {}

  const leads = [];
  
  // Esperar a que carguen los resultados
  await page.waitForSelector('div[role="feed"]');

  // Scroll simple para cargar algunos resultados
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(2000);
  }

  const resultItems = await page.$$('a[href*="/maps/place/"]');
  console.log(`Encontrados ${resultItems.length} posibles resultados.`);

  for (let i = 0; i < Math.min(resultItems.length, MAX_RESULTS); i++) {
    try {
      const item = resultItems[i];
      await item.click();
      await page.waitForTimeout(2000);

      const name = await page.innerText('h1');
      const website = await page.getAttribute('a[data-item-id="authority"]', 'href').catch(() => null);
      const phone = await page.getAttribute('button[data-tooltip="Copiar el número de teléfono"]', 'aria-label').catch(() => null);
      
      console.log(`Procesando: ${name}`);

      leads.push({
        name,
        website,
        phone: phone ? phone.replace("Copiar el número de teléfono: ", "") : null,
        source: "Google Maps"
      });
    } catch (e) {
      console.error(`Error procesando resultado ${i}:`, e.message);
    }
  }

  await browser.close();
  return leads;
}

async function syncToNotion(leads) {
  console.log(`Sincronizando ${leads.length} leads con Notion...`);

  for (const lead of leads) {
    try {
      // Intentar encontrar el Instagram desde la web (lógica simplificada)
      const instagram = lead.website ? await findInstagram(lead.website) : null;
      const whatsapp = lead.phone ? `https://wa.me/${lead.phone.replace(/\s+/g, '')}?text=Hola!%20Hemos%20visto%20tu%20perfil%20en%20Google%20Maps%20y%20nos%20ha%20parecido%20muy%20interesante%20vuestro%20centro...` : null;

      await notion.pages.create({
        parent: { database_id: DATABASE_ID },
        properties: {
          "Nombre": { title: [{ text: { content: lead.name } }] },
          "Estado": { status: { name: "Inbox" } },
          "Instagram": { url: instagram || null },
          "WhatsApp": { url: whatsapp || null },
          "Web": { url: lead.website || null },
          "Teléfono": { phone_number: lead.phone || null },
          "Fuente": { select: { name: lead.source } },
          "Fecha de Captura": { date: { start: new Date().toISOString().split('T')[0] } }
        }
      });
    } catch (e) {
      console.error(`Error al subir a Notion: ${lead.name}`, e.message);
    }
  }
}

// Función auxiliar para buscar el link de IG en una web (muy básica)
async function findInstagram(url) {
  try {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { timeout: 30000 });
    const igLink = await page.getAttribute('a[href*="instagram.com"]', 'href');
    await browser.close();
    return igLink;
  } catch (e) {
    return null;
  }
}

(async () => {
  try {
    const leads = await scrapeGoogleMaps();
    await syncToNotion(leads);
    console.log("¡Proceso completado con éxito!");
  } catch (e) {
    console.error("Error global:", e);
    process.exit(1);
  }
})();
