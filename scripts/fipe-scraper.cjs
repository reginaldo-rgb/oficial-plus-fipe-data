/**
 * FIPE Vehicle Database Scraper V2 (Smart Hybrid)
 *
 * Strategy:
 * 1. REAL API: Fetches ALL Brands and ALL Models for 'carros', 'motos', 'caminhoes' from Parallelum API.
 * 2. MANUAL SEED: Uses expanded lists for 'tratores' (includes machines) and 'barcos'.
 * 3. PRICING: Generates algorithmic prices based on vehicle type and year (to allow "All Vehicles" coverage without 50k+ price requests).
 *
 * Usage:
 *   node scripts/fipe-scraper.cjs
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

// ============================================================================
// CONFIG
// ============================================================================

const API_BASE = 'https://parallelum.com.br/fipe/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 30000; // 30s
const RATE_LIMIT_DELAY = 100; // ms between requests
const OUTPUT_DIR = path.join(__dirname, '..', 'dist-fipe');
const DB_PATH = path.join(OUTPUT_DIR, 'vehicles_db.json');

// Supported by API
const API_TYPES = ['carros', 'motos', 'caminhoes'];

// Manual Types (Not in API or requires specific handling)
const MANUAL_DATA = {
    tratores: [
        // Tratores
        { marca: 'John Deere', modelos: ['5075E', '5090E', '6100J', '6115J', '6125J', '7200J', '7230J', '8400R', '9R 590', '9RX 640'] },
        { marca: 'Massey Ferguson', modelos: ['MF 4275', 'MF 4292', 'MF 4707', 'MF 6713', 'MF 7715', 'MF 7719', 'MF 8700 S'] },
        { marca: 'New Holland', modelos: ['TL5.80', 'TL5.100', 'T6.130', 'T7.205', 'T7.240', 'T8.435', 'T9.700'] },
        { marca: 'Valtra', modelos: ['A84', 'A94', 'A114', 'A144', 'BH194', 'BH224', 'T250 CVT'] },
        { marca: 'Case IH', modelos: ['Farmall 80', 'Farmall 100', 'Puma 200', 'Magnum 340', 'Magnum 400', 'Steiger 620'] },
        { marca: 'Agrale', modelos: ['540.4', '575.4', '4230', '7215'] },
        { marca: 'LS Tractor', modelos: ['H145', 'U60', 'XU6168'] },
        { marca: 'Yanmar', modelos: ['Solis 26', 'Solis 90', 'YM 347'] },
        // Máquinas Agrícolas (Colheitadeiras/Pulverizadores) - Mapped to 'trator' in DB
        { marca: 'John Deere', modelos: ['S430 (Colheitadeira)', 'S700 (Colheitadeira)', 'M4040 (Pulverizador)', 'M4030'] },
        { marca: 'Case IH', modelos: ['Axial-Flow 4130', 'Axial-Flow 8250', 'Patriot 250'] },
        { marca: 'New Holland', modelos: ['TC 5.90', 'CR 7.90', 'Defensor 2500'] }
    ],
    barcos: [
        { marca: 'Focker', modelos: ['160', '190 Style', '210', '215', '240', '242 GTO', '270', '330', '388 Gran Turismo'] },
        { marca: 'Phantom', modelos: ['303', '345', '365', '375', '400', '500', '620'] },
        { marca: 'Schaefer', modelos: ['303', '365', '375', '400', '510', '580', '660', '770'] },
        { marca: 'Real', modelos: ['220', '24', '270', '280', '330', '365', '40', '525', '60'] },
        { marca: 'Cimitarra', modelos: ['340', '360', '440', '500', '540', '600', '760'] },
        { marca: 'Bayliner', modelos: ['VR5', 'VR6', '280', '320', '350'] },
        { marca: 'Sea-Doo', modelos: ['Spark', 'GTI 130', 'GTI 170', 'GTR 230', 'RXP-X 300', 'RXT-X 300', 'GTX 300'] },
        { marca: 'Yamaha', modelos: ['VX Cruiser', 'GP1800R', 'FX Cruiser', 'SuperJet', 'FX SVHO'] }
    ]
};

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: { 'User-Agent': UA },
            timeout: TIMEOUT
        }, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout for ${url}`));
        });
    });
}

function generateId(tipo, marca, modelo, ano) {
    const clean = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return `${clean(tipo)}-${clean(marca)}-${clean(modelo)}-${ano}`;
}

// Algorithmic Price Generator (to avoid 50k stats requests)
function generatePrice(tipo, marca, modelo, ano) {
    const now = new Date();
    const age = now.getFullYear() - ano;

    let basePrice = 0;
    // Base prices roughly by type
    if (tipo === 'carros') basePrice = 90000;
    if (tipo === 'motos') basePrice = 25000;
    if (tipo === 'caminhoes') basePrice = 500000;
    if (tipo === 'tratores') basePrice = 350000;
    if (tipo === 'barcos') basePrice = 150000;

    // Hash variation
    const hash = (marca + modelo).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    basePrice += (hash * 100);

    // Depreciation
    if (age > 0) {
        basePrice = basePrice * Math.pow(0.92, age); // 8% depreciation per year
    }

    // Luxury brands multiplier
    const LUXURY = ['BMW', 'Audi', 'Mercedes-Benz', 'Volvo', 'Land Rover', 'Porsche', 'Ferrari', 'Lamborghini', 'Jaguar', 'Lexus'];
    if (LUXURY.some(l => marca.includes(l))) basePrice *= 2.5;

    // Specific type multipliers
    if (tipo === 'caminhoes' && (modelo.includes('FH') || modelo.includes('R 450'))) basePrice *= 1.5;
    if (tipo === 'motos' && (modelo.includes('CB 1000') || modelo.includes('R1') || modelo.includes('S 1000'))) basePrice *= 1.8;

    return Math.round(basePrice);
}

// ============================================================================
// LOGIC
// ============================================================================

async function fetchBrands(tipo) {
    try {
        console.log(`  Fetching brands for ${tipo}...`);
        const url = `${API_BASE}/${tipo}/marcas`;
        return await fetchJSON(url);
    } catch (e) {
        console.warn(`  Failed to fetch brands for ${tipo}: ${e.message}`);
        return [];
    }
}

async function fetchModels(tipo, brandId) {
    try {
        const url = `${API_BASE}/${tipo}/marcas/${brandId}/modelos`;
        const res = await fetchJSON(url);
        return res.modelos || [];
    } catch (e) {
        console.warn(`  Failed logic for brand ${brandId}: ${e.message}`);
        return [];
    }
}

// ============================================================================
// MAIN SCRAPER
// ============================================================================

async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log('  FIPE Smart Scraper V2 (Hybrid)');
    console.log(`  ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════');

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    let allVehicles = [];
    const now = new Date();
    const currentYear = now.getFullYear();

    // 1. PROCESS API TYPES (Real Data)
    for (const tipo of API_TYPES) {
        console.log(`\n📡 Processing API Type: ${tipo.toUpperCase()}`);

        const brands = await fetchBrands(tipo);
        console.log(`  Found ${brands.length} brands.`);

        let processedBrands = 0;

        for (const brand of brands) {
            process.stdout.write(`  [${Math.round((processedBrands / brands.length) * 100)}%] Fetching models for ${brand.nome}... \r`);

            await sleep(RATE_LIMIT_DELAY); // Rate limiting
            const models = await fetchModels(tipo, brand.codigo);

            if (models.length > 0) {
                // Generate vehicles for this brand/model
                for (const model of models) {
                    // Generate for last 15 years
                    for (let ano = 2010; ano <= currentYear + 1; ano++) {
                        // Normalize DB type
                        let dbTipo = 'carro';
                        if (tipo === 'motos') dbTipo = 'moto';
                        if (tipo === 'caminhoes') dbTipo = 'caminhao';

                        allVehicles.push({
                            id: generateId(dbTipo, brand.nome, model.nome, ano),
                            tipo: dbTipo,
                            marca: brand.nome,
                            modelo: model.nome,
                            ano: ano,
                            preco: generatePrice(tipo, brand.nome, model.nome, ano),
                            fipe_code: `${brand.codigo}-${model.codigo}`, // Real IDs where possible
                            last_updated: now.toISOString()
                        });
                    }
                }
            }
            processedBrands++;
        }
        console.log(`\n  ✅ ${tipo}: Processed ${allVehicles.length} entries so far.`);
    }

    // 2. PROCESS MANUAL TYPES (Expanded Seed)
    for (const [tipo, marcas] of Object.entries(MANUAL_DATA)) {
        console.log(`\n🌱 Processing Manual Type: ${tipo.toUpperCase()}`);

        for (const fab of marcas) {
            for (const modelo of fab.modelos) {
                for (let ano = 2010; ano <= currentYear + 1; ano++) {
                    let dbTipo = 'trator'; // default
                    if (tipo === 'barcos') dbTipo = 'barco';

                    allVehicles.push({
                        id: generateId(dbTipo, fab.marca, modelo, ano),
                        tipo: dbTipo,
                        marca: fab.marca,
                        modelo: modelo,
                        ano: ano,
                        preco: generatePrice(tipo, fab.marca, modelo, ano),
                        fipe_code: 'MANUAL-SEED',
                        last_updated: now.toISOString()
                    });
                }
            }
        }
    }

    // 3. FINALIZE
    console.log(`\n💾 Saving database with ${allVehicles.length} unique vehicles...`);

    // Stats
    const stats = {};
    for (const v of allVehicles) stats[v.tipo] = (stats[v.tipo] || 0) + 1;

    const version = `${currentYear}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;

    // JSON
    const output = { version, generated_at: now.toISOString(), vehicles: allVehicles, stats };
    const jsonStr = JSON.stringify(output);
    fs.writeFileSync(DB_PATH, jsonStr);

    // GZIP
    const gzipped = zlib.gzipSync(Buffer.from(jsonStr), { level: 9 });
    fs.writeFileSync(DB_PATH + '.gz', gzipped);

    // Metadata
    const metadata = {
        version,
        generated_at: now.toISOString(),
        vehicles_count: allVehicles.length,
        json_size_bytes: jsonStr.length,
        gzip_size_bytes: gzipped.length,
        stats
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2));

    console.log('\n📊 Final Statistics:');
    console.log(JSON.stringify(stats, null, 2));

    if (process.env.GITHUB_OUTPUT) {
        const outputFile = process.env.GITHUB_OUTPUT;
        fs.appendFileSync(outputFile, `version=${version}\n`);
        fs.appendFileSync(outputFile, `vehicles_count=${allVehicles.length}\n`);
        fs.appendFileSync(outputFile, `gzip_size=${gzipped.length}\n`);
        fs.appendFileSync(outputFile, `stats=${JSON.stringify(stats)}\n`);
    }

    console.log('✅ Done.');
}

main().catch(console.error);
