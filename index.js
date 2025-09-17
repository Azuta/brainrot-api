// Cargar variables de entorno del archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Configuración
const app = express();
const port = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- REGLAS DEL JUEGO ---
const INVENTORY_LIMIT = 10;
const FARM_COOLDOWN_MS = 1 * 60 * 1000; // 1 minuto
const STEAL_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 hora
const REPLACE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos para reemplazar

app.use(cors());
app.use(express.json());

// --- FUNCIONES AUXILIARES ---

// Ahora busca o crea en la nueva tabla 'users'
async function getOrCreateUser(username) {
  const cleanUsername = username.toLowerCase();
  let { data: user, error } = await supabase.from('users').select('*').eq('user_name', cleanUsername).single();
  if (error && error.code === 'PGRST116') {
    const { data: newUser, error: createError } = await supabase.from('users').insert({ user_name: cleanUsername }).select().single();
    if (createError) throw createError;
    return newUser;
  }
  if (error) throw error;
  return user;
}

function formatTimeLeft(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    let result = '';
    if (minutes > 0) result += `${minutes} minuto(s) `;
    if (seconds > 0) result += `${seconds} segundo(s)`;
    return result.trim();
}

async function getWeightedRandomBrainrot() {
    const { data: allBrainrots, error } = await supabase.from('brainrots').select('id, name, rarity');
    if (error) throw error;
    const rarityWeights = { 'Common': 15, 'Rare': 10, 'Epic': 7, 'Legendary': 4, 'Mythic': 2, 'Brainrot God': 1, 'Secret': 1, 'OG': 1 };
    const weightedPool = [];
    allBrainrots.forEach(brainrot => {
        const weight = rarityWeights[brainrot.rarity] || 1;
        for (let i = 0; i < weight; i++) {
            weightedPool.push(brainrot);
        }
    });
    return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}

// --- ENDPOINT PRINCIPAL DE LA API ---
const brainrotHandler = async (req, res) => {
    try {
        const { username, action: rawAction } = req.params;
        const target = req.params.target ? req.params.target.replace('@', '').toLowerCase() : null;
        const action = rawAction.toLowerCase();

        if (!username || !action) return res.status(400).send('Petición mal formada.');

        await supabase.from('inventories').delete().eq('user_name', username).eq('is_temporary_for_replacement', true).lt('temp_timestamp', new Date(Date.now() - REPLACE_TIMEOUT_MS).toISOString());

        switch (action) {
            case 'farmear': {
                const user = await getOrCreateUser(username);
                if (user.last_farmed_at && (Date.now() - new Date(user.last_farmed_at).getTime() < FARM_COOLDOWN_MS)) {
                    const timeLeft = new Date(user.last_farmed_at).getTime() + FARM_COOLDOWN_MS - Date.now();
                    return res.send(`${username}, teikirisi! Puedes volver a farmear en ${formatTimeLeft(timeLeft)}.`);
                }
                
                const { data: inventory, error: invError } = await supabase.from('inventories').select('id', { count: 'exact' }).eq('user_name', username).eq('is_temporary_for_replacement', false);
                if (invError) throw invError;

                await supabase.from('users').update({ last_farmed_at: new Date() }).eq('user_name', username);

                const farmedBrainrot = await getWeightedRandomBrainrot();
                if (inventory.length >= INVENTORY_LIMIT) {
                    await supabase.from('inventories').insert({ user_name: username, brainrot_id: farmedBrainrot.id, is_temporary_for_replacement: true, temp_timestamp: new Date() });
                    return res.send(`¡Inventario lleno! Has encontrado un "${farmedBrainrot.name}". Tienes 10 minutos para usar "!brainrot remplazo {ID}" o se lo lleva el diabolo.`);
                } else {
                    await supabase.from('inventories').insert({ user_name: username, brainrot_id: farmedBrainrot.id });
                    return res.send(`Worales ${username} ha farmeado: "${farmedBrainrot.name}" (${farmedBrainrot.rarity})!`);
                }
            }

            case 'inventario': {
                const { data: items, error } = await supabase.from('inventories').select(`id, brainrots (name, rarity), is_temporary_for_replacement`).eq('user_name', username).order('created_at', { ascending: true });
                if (error) throw error;
                const permanentItems = items.filter(i => !i.is_temporary_for_replacement);
                const tempItem = items.find(i => i.is_temporary_for_replacement);
                if (permanentItems.length === 0 && !tempItem) return res.send(`El inventario de ${username} está vacío (0/${INVENTORY_LIMIT}).`);
                const inventoryText = permanentItems.map(item => `[${item.id}] "${item.brainrots.name}" (${item.brainrots.rarity})`).join(' | ');
                let message = `Inventario de ${username} (${permanentItems.length}/${INVENTORY_LIMIT}): ${inventoryText}`;
                if (tempItem) message += ` | TIENES PENDIENTE: "${tempItem.brainrots.name}" (${tempItem.brainrots.rarity}). Usa "!brainrot remplazo {ID}".`;
                return res.send(message);
            }
            
                case 'descartar': {
                const discardId = parseInt(target, 10);
                if (isNaN(discardId)) {
                     // --- INICIO DE LA LÓGICA CORREGIDA ---
                    const { data: items, error } = await supabase.from('inventories').select(`id, brainrots (name)`).eq('user_name', username).eq('is_temporary_for_replacement', false).order('created_at', { ascending: true });
                    if(error || items.length === 0){
                        return res.send(`ID inválido. Tu inventario está vacío, no hay nada que descartar.`);
                    }
                    const inventoryText = items.map(item => `[${item.id}] "${item.brainrots.name}"`).join(' | ');
                    return res.send(`Debes proporcionar un ID válido. Tu inventario es: ${inventoryText}`);
                     // --- FIN DE LA LÓGICA CORREGIDA ---
                }

                const { data: itemToDelete, error: findError } = await supabase.from('inventories').select(`id, brainrots (name)`).eq('user_name', username).eq('id', discardId).single();
                
                if (findError || !itemToDelete) {
                    // --- INICIO DE LA LÓGICA CORREGIDA ---
                    const { data: items, error } = await supabase.from('inventories').select(`id, brainrots (name)`).eq('user_name', username).eq('is_temporary_for_replacement', false).order('created_at', { ascending: true });
                     if(error || items.length === 0){
                        return res.send(`ID [${discardId}] inválido. Tu inventario está vacío.`);
                    }
                    const inventoryText = items.map(item => `[${item.id}] "${item.brainrots.name}"`).join(' | ');
                    return res.send(`ID [${discardId}] inválido. Elige un número de la lista. Tu inventario es: ${inventoryText}`);
                    // --- FIN DE LA LÓGICA CORREGIDA ---
                }

                await supabase.from('inventories').delete().eq('id', discardId);
                return res.send(`🗑️ Has descartado el brainrot [${discardId}]: "${itemToDelete.brainrots.name}".`);
            }

            case 'remplazo': {
                const replaceId = parseInt(target, 10);
                if (isNaN(replaceId)) return res.send(`ID inválido. Debes proporcionar el número del brainrot a reemplazar.`);
                const { data: tempItem, error: tempError } = await supabase.from('inventories').select('*').eq('user_name', username).eq('is_temporary_for_replacement', true).single();
                if (tempError || !tempItem) return res.send('No tienes ningún brainrot pendiente para reemplazar.');
                await supabase.from('inventories').delete().eq('id', replaceId).eq('user_name', username);
                await supabase.from('inventories').update({ is_temporary_for_replacement: false, temp_timestamp: null }).eq('id', tempItem.id);
                return res.send(`¡Reemplazo exitoso! Tu nuevo brainrot está en el inventario.`);
            }
            
            case 'robar': {
                const thief = await getOrCreateUser(username);
                if (thief.last_stole_at && (Date.now() - new Date(thief.last_stole_at).getTime() < STEAL_COOLDOWN_MS)) {
                    const timeLeft = new Date(thief.last_stole_at).getTime() + STEAL_COOLDOWN_MS - Date.now();
                    return res.send(`${username}, teikirisi! Puedes volver a robar en ${formatTimeLeft(timeLeft)}.`);
                }

                let victimName;
                if (target) {
                    if (target === username) return res.send(`${username} intentó robarse a sí todo baboso y solo consiguió perder su dignidad.`);
                    victimName = target;
                } else {
                    const { data: potentialVictims } = await supabase.from('inventories').select('user_name').not('user_name', 'eq', username);
                    if (!potentialVictims || potentialVictims.length === 0) return res.send('No hay víctimas con brainrots en el servidor.');
                    const uniqueVictims = [...new Set(potentialVictims.map(p => p.user_name))];
                    victimName = uniqueVictims[Math.floor(Math.random() * uniqueVictims.length)];
                }
                
                const { data: victimItems } = await supabase.from('inventories').select('id, is_temporary_for_replacement').eq('user_name', victimName);
                if (!victimItems || victimItems.filter(i => !i.is_temporary_for_replacement).length === 0) return res.send(`${victimName.toUpperCase()} no tiene brainrots para robar.`);
                
                await supabase.from('users').update({ last_stole_at: new Date() }).eq('user_name', username);

                if (Math.random() < 0.5) {
                    return res.send(`¡Robo fallido! ${victimName} se dio cuenta y aseguró sus brainrots. ${username} todo wey huye con las manos vacías.`);
                }

                const stealableItems = victimItems.filter(i => !i.is_temporary_for_replacement);
                const stolenItem = stealableItems[Math.floor(Math.random() * stealableItems.length)];
                const { data: thiefInventory } = await supabase.from('inventories').select('id', { count: 'exact' }).eq('user_name', username).eq('is_temporary_for_replacement', false);
                const { data: stolenItemData } = await supabase.from('inventories').select(`brainrots (name)`).eq('id', stolenItem.id).single();

                if (thiefInventory.length >= INVENTORY_LIMIT) {
                    await supabase.from('inventories').update({ user_name: username, is_temporary_for_replacement: true, temp_timestamp: new Date() }).eq('id', stolenItem.id);
                    return res.send(`¡ROBO EXITOSO! ${username} le ha robado un "${stolenItemData.brainrots.name}" a ${victimName}, pero su inventario está lleno. Tienes 10 minutos para usar "!brainrot remplazo {ID}".`);
                } else {
                    await supabase.from('inventories').update({ user_name: username }).eq('id', stolenItem.id);
                    return res.send(`¡ROBO EXITOSO! ${username} le ha robado un "${stolenItemData.brainrots.name}" a ${victimName}!`);
                }
            }

            default:
                const helpMessage = `
                🧠 ¡Bienvenido al Juego de Brainrot hecho por Kednewt!
                Límite de inventario: ${INVENTORY_LIMIT}. 
                Comandos: 
                [!brainrot farmear] - Consigue un brainrot nuevo (1 hora cooldown).
                [!brainrot inventario] - Muestra tus brainrots y su ID. 
                [!brainrot robar @usuario] - Intenta robar un ítem (1 hora cooldown).
                [!brainrot remplazo ID] - Si tu inventario está lleno, usa esto para cambiar el ítem nuevo por uno viejo.`;
                return res.send(helpMessage);

        }
    } catch (error) {
        console.error('Error en el endpoint /brainrot:', error);
        res.status(500).json({ message: 'Algo falló, pero no te preocupes que la Kednewt resuelve.', error: error.message });
    }
};

// --- DEFINICIÓN DE RUTAS ---
// Ruta para comandos CON objetivo (ej. robar, descartar)
app.get('/brainrot/:username/:action/:target', brainrotHandler);
// Ruta para comandos SIN objetivo (ej. farmear, inventario)
app.get('/brainrot/:username/:action', brainrotHandler);

// Iniciar el servidor
app.listen(port, () => {
    console.log(`API de Brainrot (v3 - Definitiva) escuchando en http://localhost:${port}`);
});
