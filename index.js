// Cargar variables de entorno
require('dotenv').config();

// Importar librerías
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// Configuración de la App y Supabase
const app = express();
const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Middlewares
app.use(cors());
app.use(express.json()); // Para poder leer JSON en el body de las peticiones

// --- LÓGICA DEL JUEGO ---

// Función para obtener o crear un usuario en la base de datos
async function getOrCreateUser(username) {
  username = username.toLowerCase();
  let { data: user, error } = await supabase
    .from('inventories')
    .select('*')
    .eq('user_name', username)
    .single();

  if (error && error.code === 'PGRST116') { // Si el usuario no existe, lo creamos
    const { data: newUser, error: createError } = await supabase
      .from('inventories')
      .insert({ user_name: username, brainrot_ids: [] })
      .select()
      .single();
    if (createError) throw createError;
    return newUser;
  }
  if (error) throw error;
  return user;
}


// --- RUTAS DE LA API ---

// Ruta para obtener el inventario de un usuario
app.get('/inventory/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await getOrCreateUser(username);

    if (user.brainrot_ids.length === 0) {
      return res.send(`El inventario de ${username} está vacío.`);
    }

    const { data: brainrots, error } = await supabase
      .from('brainrots')
      .select('name, rarity')
      .in('id', user.brainrot_ids);
    
    if (error) throw error;

    const inventoryText = brainrots.map(b => `${b.name} (${b.rarity})`).join(', ');
    res.send(`Inventario de ${username}: ${inventoryText}`);

  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
});


// Ruta para que un usuario farmee un brainrot
app.post('/farm', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).send('Falta el nombre de usuario.');
    
    // 1. Obtener todos los brainrots
    const { data: allBrainrots, error: fetchError } = await supabase.from('brainrots').select('id, name, rarity');
    if (fetchError) throw fetchError;
    if (!allBrainrots || allBrainrots.length === 0) return res.send('No hay brainrots para farmear.');

    // 2. Elegir uno al azar
    const farmedBrainrot = allBrainrots[Math.floor(Math.random() * allBrainrots.length)];

    // 3. Añadirlo al inventario del usuario
    const user = await getOrCreateUser(username);
    const newInventoryIds = [...user.brainrot_ids, farmedBrainrot.id];

    const { error: updateError } = await supabase
      .from('inventories')
      .update({ brainrot_ids: newInventoryIds })
      .eq('user_name', user.user_name);
    
    if (updateError) throw updateError;
    
    res.send(`${username} ha farmeado un: ${farmedBrainrot.name} (${farmedBrainrot.rarity})!`);

  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
});

// ########## NUEVA RUTA PARA ROBAR ##########
app.post('/steal', async (req, res) => {
    try {
        const { thief, victim } = req.body;
        if (!thief || !victim) {
            return res.status(400).send('Faltan el ladrón (thief) o la víctima (victim).');
        }
        if (thief.toLowerCase() === victim.toLowerCase()){
            return res.send(`${thief} intentó robarse a sí mismo y solo consiguió perder su dignidad.`);
        }

        // 1. Obtener datos de ambos usuarios
        const thiefUser = await getOrCreateUser(thief);
        const victimUser = await getOrCreateUser(victim);
        
        // 2. Comprobar si la víctima tiene algo que robar
        if (!victimUser.brainrot_ids || victimUser.brainrot_ids.length === 0) {
            return res.send(`${victim.toUpperCase()} no tiene brainrots. ${thief} intentó robarle a un pobre.`);
        }

        // 3. Simular la probabilidad de éxito del robo (ej. 50%)
        if (Math.random() < 0.5) { // 50% de probabilidad de fallar
            return res.send(`¡Robo fallido! ${victim} se dio cuenta y aseguró sus memes. ${thief} huye con las manos vacías.`);
        }

        // 4. Si el robo es exitoso, elegir un item al azar del inventario de la víctima
        const stolenItemIndex = Math.floor(Math.random() * victimUser.brainrot_ids.length);
        const stolenItemId = victimUser.brainrot_ids[stolenItemIndex];

        // 5. Actualizar los inventarios
        // Quitar el item de la víctima
        const victimNewInventory = victimUser.brainrot_ids.filter((_, index) => index !== stolenItemIndex);
        // Añadir el item al ladrón
        const thiefNewInventory = [...thiefUser.brainrot_ids, stolenItemId];

        // 6. Subir los cambios a la base de datos
        const { error: victimUpdateError } = await supabase
            .from('inventories')
            .update({ brainrot_ids: victimNewInventory })
            .eq('user_name', victimUser.user_name);

        const { error: thiefUpdateError } = await supabase
            .from('inventories')
            .update({ brainrot_ids: thiefNewInventory })
            .eq('user_name', thiefUser.user_name);

        if (victimUpdateError || thiefUpdateError) {
            throw new Error('Error al actualizar los inventarios en la base de datos.');
        }
        
        // 7. Obtener el nombre del item robado para el mensaje final
        const { data: stolenItemData } = await supabase.from('brainrots').select('name').eq('id', stolenItemId).single();

        res.send(`¡ROBO EXITOSO! ${thief} le ha robado un [${stolenItemData.name}] a ${victim}!`);

    } catch (error) {
        res.status(500).json({ message: 'Error en el servidor', error: error.message });
    }
});


// Iniciar el servidor
app.listen(port, () => {
  console.log(`API de Brainrot escuchando en http://localhost:${port}`);
});