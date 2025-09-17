// Cargar variables de entorno del archivo .env
require('dotenv').config();

// Importar las librerías necesarias
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Configuración de la aplicación Express y el cliente de Supabase
const app = express();
const port = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- CONFIGURACIÓN DE LAS REGLAS DEL JUEGO ---
const INVENTORY_LIMIT = 10;
const FARM_COOLDOWN_MS = 1 * 60 * 1000; // 1 minuto
const STEAL_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 hora
const REPLACE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos para reemplazar

// Middlewares para permitir peticiones externas (CORS) y leer JSON
app.use(cors());
app.use(express.json());

// --- FUNCIONES AUXILIARES ---

/**
 * Busca un usuario en la DB por su nombre. Si no existe, lo crea con valores por defecto.
 * @param {string} username - El nombre de usuario de Twitch.
 * @returns {Promise<object>} El objeto del usuario desde la base de datos.
 */
async function getOrCreateUser(username) {
  const cleanUsername = username.toLowerCase();
  let { data: user, error } = await supabase
    .from('inventories')
    .select('*')
    .eq('user_name', cleanUsername)
    .single();

  if (error && error.code === 'PGRST116') { // Código de Supabase para "no rows returned"
    const { data: newUser, error: createError } = await supabase
      .from('inventories')
      .insert({ user_name: cleanUsername, brainrot_ids: [], protected_ids: [] })
      .select()
      .single();
    if (createError) throw createError;
    return newUser;
  }
  if (error) throw error;
  return user;
}

/**
 * Formatea un tiempo en milisegundos a un texto legible (ej. "1 minuto 30 segundos").
 * @param {number} ms - Milisegundos restantes.
 * @returns {string} El tiempo formateado.
 */
function formatTimeLeft(ms) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    let result = '';
    if (minutes > 0) result += `${minutes} minuto(s) `;
    if (seconds > 0) result += `${seconds} segundo(s)`;
    return result.trim();
}

/**
 * Obtiene un brainrot aleatorio de la base de datos, ponderando por su rareza.
 * @returns {Promise<object>} Un objeto de brainrot aleatorio.
 */
async function getWeightedRandomBrainrot() {
    const { data: allBrainrots, error } = await supabase.from('brainrots').select('id, name, rarity');
    if (error) throw error;

    const rarityWeights = { 'Common': 15, 'Rare': 10, 'Epic': 7, 'Legendary': 4, 'Mythic': 2, 'Brainrot God': 1, 'Secret': 1, 'OG': 1 };
    const weightedPool = [];

    allBrainrots.forEach(brainrot => {
        const weight = rarityWeights[brainrot.rarity] || 1; // Si la rareza no está en la lista, peso de 1
        for (let i = 0; i < weight; i++) {
            weightedPool.push(brainrot);
        }
    });

    return weightedPool[Math.floor(Math.random() * weightedPool.length)];
}


// --- ENDPOINT PRINCIPAL DE LA API ---

app.post('/brainrot', async (req, res) => {
    try {
        const { username, args } = req.body;
        if (!username || !args || args.length === 0) {
            return res.status(400).send('Petición mal formada. Se requiere "username" y "args".');
        }

        const action = args[0].toLowerCase();
        const target = args[1] ? args[1].replace('@', '').toLowerCase() : null;
        
        let user = await getOrCreateUser(username);

        // Antes de cualquier acción, limpiar un brainrot temporal expirado si lo hubiera
        if (user.temp_brainrot_id && (Date.now() - new Date(user.temp_brainrot_timestamp).getTime() > REPLACE_TIMEOUT_MS)) {
            await supabase.from('inventories').update({ temp_brainrot_id: null, temp_brainrot_timestamp: null }).eq('user_name', user.user_name);
            user.temp_brainrot_id = null; // Actualizamos el objeto local también
        }

        // --- GESTOR DE ACCIONES ---
        switch (action) {
            case 'farmear': {
                if (user.last_farmed_at && (Date.now() - new Date(user.last_farmed_at).getTime() < FARM_COOLDOWN_MS)) {
                    const timeLeft = new Date(user.last_farmed_at).getTime() + FARM_COOLDOWN_MS - Date.now();
                    return res.send(`${username}, espera! Puedes volver a farmear en ${formatTimeLeft(timeLeft)}.`);
                }

                const farmedBrainrot = await getWeightedRandomBrainrot();
                
                if (user.brainrot_ids.length < INVENTORY_LIMIT) {
                    const newInventory = [...user.brainrot_ids, farmedBrainrot.id];
                    await supabase.from('inventories').update({ brainrot_ids: newInventory, last_farmed_at: new Date() }).eq('user_name', user.user_name);
                    return res.send(`${username} ha farmeado: ${farmedBrainrot.name} (${farmedBrainrot.rarity})!`);
                } else {
                    await supabase.from('inventories').update({ temp_brainrot_id: farmedBrainrot.id, temp_brainrot_timestamp: new Date(), last_farmed_at: new Date() }).eq('user_name', user.user_name);
                    return res.send(`¡Inventario lleno! ${username} ha encontrado un ${farmedBrainrot.name} (${farmedBrainrot.rarity}). Tienes 10 minutos para usar "!brainrot remplazo {ID}" o lo perderás.`);
                }
            }

            case 'inventario': {
                if (user.brainrot_ids.length === 0) {
                    let message = `El inventario de ${username} está vacío (0/${INVENTORY_LIMIT}).`;
                    if (user.temp_brainrot_id) {
                         const { data: tempBrainrot } = await supabase.from('brainrots').select('name, rarity').eq('id', user.temp_brainrot_id).single();
                         message += ` | TIENES PENDIENTE: ${tempBrainrot.name} (${tempBrainrot.rarity}). Usa "!brainrot remplazo {ID}".`;
                    }
                    return res.send(message);
                }

                // Preservar el orden del inventario al mostrarlo
                const { data: brainrotsDetails } = await supabase.from('brainrots').select('id, name, rarity').in('id', user.brainrot_ids);
                const detailsMap = new Map(brainrotsDetails.map(b => [b.id, b]));
                const inventoryText = user.brainrot_ids.map((id, index) => {
                    const details = detailsMap.get(id);
                    return `[${index + 1}] ${details.name} (${details.rarity})`;
                }).join(' | ');
                
                let message = `Inventario de ${username} (${user.brainrot_ids.length}/${INVENTORY_LIMIT}): ${inventoryText}`;
                
                if (user.temp_brainrot_id) {
                    const { data: tempBrainrot } = await supabase.from('brainrots').select('name, rarity').eq('id', user.temp_brainrot_id).single();
                    message += ` | TIENES PENDIENTE: ${tempBrainrot.name} (${tempBrainrot.rarity}). Usa "!brainrot remplazo {ID}".`;
                }
                return res.send(message);
            }

            case 'remplazo': {
                const replaceIndex = parseInt(target, 10) - 1; // El usuario ve ID [1], pero en el array es el índice 0

                if (isNaN(replaceIndex) || replaceIndex < 0 || replaceIndex >= user.brainrot_ids.length) {
                    return res.send(`ID inválido. Elige un número entre 1 y ${user.brainrot_ids.length}.`);
                }
                if (!user.temp_brainrot_id) {
                    return res.send('No tienes ningún brainrot pendiente para reemplazar.');
                }
                
                const itemToReplaceId = user.brainrot_ids[replaceIndex];
                const { data: itemToReplaceData } = await supabase.from('brainrots').select('name').eq('id', itemToReplaceId).single();
                const { data: tempBrainrotData } = await supabase.from('brainrots').select('name').eq('id', user.temp_brainrot_id).single();

                const newInventory = [...user.brainrot_ids];
                newInventory[replaceIndex] = user.temp_brainrot_id;
                
                await supabase.from('inventories').update({ brainrot_ids: newInventory, temp_brainrot_id: null, temp_brainrot_timestamp: null }).eq('user_name', user.user_name);

                return res.send(`¡Reemplazo exitoso! Has cambiado tu [${itemToReplaceData.name}] por un [${tempBrainrotData.name}].`);
            }
            
            case 'robar': {
                if (user.last_stole_at && (Date.now() - new Date(user.last_stole_at).getTime() < STEAL_COOLDOWN_MS)) {
                    const timeLeft = new Date(user.last_stole_at).getTime() + STEAL_COOLDOWN_MS - Date.now();
                    return res.send(`${username}, calma esas manos! Puedes volver a robar en ${formatTimeLeft(timeLeft)}.`);
                }
                
                let victim;
                if (target) {
                    if (target === username) return res.send(`${username} intentó robarse a sí mismo y solo consiguió perder su dignidad.`);
                    victim = await getOrCreateUser(target);
                } else {
                    // Elegir víctima aleatoria que tenga items y no sea el ladrón
                    const { data: potentialVictims } = await supabase
                        .from('inventories')
                        .select('user_name')
                        .not('user_name', 'eq', username)
                        .gt('brainrot_ids', '{}'); // array no está vacío
                    
                    if (!potentialVictims || potentialVictims.length === 0) return res.send('No hay víctimas con brainrots en el servidor ahora mismo.');
                    const randomVictimName = potentialVictims[Math.floor(Math.random() * potentialVictims.length)].user_name;
                    victim = await getOrCreateUser(randomVictimName);
                }

                if (!victim.brainrot_ids || victim.brainrot_ids.length === 0) {
                    return res.send(`${victim.user_name.toUpperCase()} no tiene brainrots. ${username} intentó robarle a un pobre.`);
                }
                
                // Actualizar el cooldown del ladrón sin importar el resultado
                await supabase.from('inventories').update({ last_stole_at: new Date() }).eq('user_name', user.user_name);

                // 50/50 Probabilidad de éxito
                if (Math.random() < 0.5) {
                    return res.send(`¡Robo fallido! ${victim.user_name} se dio cuenta y aseguró sus memes. ${username} huye con las manos vacías.`);
                }

                // Robo exitoso
                const stolenItemIndex = Math.floor(Math.random() * victim.brainrot_ids.length);
                const stolenItemId = victim.brainrot_ids[stolenItemIndex];
                
                // Quitar item a la víctima
                const victimNewInventory = victim.brainrot_ids.filter((_, index) => index !== stolenItemIndex);
                await supabase.from('inventories').update({ brainrot_ids: victimNewInventory }).eq('user_name', victim.user_name);

                const { data: stolenItemData } = await supabase.from('brainrots').select('name, rarity').eq('id', stolenItemId).single();
                
                // Dar item al ladrón (gestionando inventario lleno)
                if (user.brainrot_ids.length < INVENTORY_LIMIT) {
                    const thiefNewInventory = [...user.brainrot_ids, stolenItemId];
                    await supabase.from('inventories').update({ brainrot_ids: thiefNewInventory }).eq('user_name', user.user_name);
                    return res.send(`¡ROBO EXITOSO! ${username} le ha robado un [${stolenItemData.name}] a ${victim.user_name}!`);
                } else {
                    await supabase.from('inventories').update({ temp_brainrot_id: stolenItemId, temp_brainrot_timestamp: new Date() }).eq('user_name', user.user_name);
                    return res.send(`¡ROBO EXITOSO! ${username} le ha robado un [${stolenItemData.name}] a ${victim.user_name}, pero su inventario está lleno. Tienes 10 minutos para usar "!brainrot remplazo {ID}".`);
                }
            }

            default:
                return res.send('Acción desconocida. Usa: farmear, robar, inventario, remplazo.');
        }
    } catch (error) {
        console.error('Error en el endpoint /brainrot:', error);
        res.status(500).json({ message: 'Ocurrió un error inesperado en el servidor.', error: error.message });
    }
});

// Iniciar el servidor para que escuche peticiones
app.listen(port, () => {
    console.log(`API de Brainrot (v2) escuchando en http://localhost:${port}`);
});
