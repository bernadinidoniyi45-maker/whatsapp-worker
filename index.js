const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

// Verification de securite au demarrage
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERREUR CRITIQUE: Variables SUPABASE manquantes.");
    process.exit(1); // Arreter le processus si config manquante
}

console.log(`Connexion Supabase: ${SUPABASE_URL}`); // Log pour debug

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

// Stockage des sessions actives en memoire
const activeSessions = new Map();

app.use(cors());
app.use(express.json());

// --- 1. GESTION DE LA SAUVEGARDE (Supabase Auth) ---
const useSupabaseAuth = async (sessionId) => {
    const writeData = async (data, key) => {
        const { error } = await supabase
            .from('whatsapp_sessions')
            .upsert({ 
                session_id: sessionId, 
                key_id: key, 
                data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)),
                updated_at: new Date().toISOString()
            });
        if (error) console.error('Erreur sauvegarde Auth:', error.message);
    };

    const readData = async (key) => {
        const { data } = await supabase
            .from('whatsapp_sessions')
            .select('data')
            .eq('session_id', sessionId)
            .eq('key_id', key)
            .single();
        return data?.data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
    };

    const removeData = async (key) => {
        await supabase.from('whatsapp_sessions').delete().eq('session_id', sessionId).eq('key_id', key);
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};

// --- 2. MOTEUR WHATSAPP ---
const startWhatsApp = async (instanceId) => {
    console.log(`Demarrage session pour: ${instanceId}`);
    
    // Eviter les sessions dupliquees
    if (activeSessions.has(instanceId)) {
        console.log(`Session ${instanceId} deja active, fermeture...`);
        try {
            activeSessions.get(instanceId).end();
        } catch (e) {}
        activeSessions.delete(instanceId);
    }

    const { state, saveCreds } = await useSupabaseAuth(instanceId);
    const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        // 👇 LE CHANGEMENT EST ICI 👇
        browser: ["Ubuntu", "Chrome", "20.0.04"], // On se fait passer pour Linux
        connectTimeoutMs: 60000,
        syncFullHistory: false, // ⚠️ TRES IMPORTANT : Evite de surcharger le serveur au scan
        markOnlineOnConnect: false,
    });


    activeSessions.set(instanceId, sock);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`QR Code recu pour ${instanceId}! Mise a jour Supabase...`);
            const { error } = await supabase
                .from('instances')
                .update({ qr_code: qr, status: 'scanning' })
                .eq('id', instanceId);
            
            if (error) {
                console.error(`Erreur update QR:`, error.message);
            } else {
                console.log(`QR sauvegarde avec succes pour ${instanceId}`);
            }
        }

        if (connection === 'open') {
            console.log(`${instanceId} est connecte !`);
            await supabase
                .from('instances')
                .update({ qr_code: null, status: 'connected' })
                .eq('id', instanceId);
        }

        if (connection === 'close') {
            activeSessions.delete(instanceId);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Deconnexion ${instanceId}. Code: ${statusCode}. Reconnexion: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startWhatsApp(instanceId), 3000); // Delai avant reconnexion
            } else {
                await supabase
                    .from('instances')
                    .update({ status: 'disconnected', qr_code: null })
                    .eq('id', instanceId);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    
    return sock;
};

// --- 3. ROUTES API ---

app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'WhatsApp Worker is Running',
        activeSessions: activeSessions.size,
        supabaseUrl: SUPABASE_URL
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', activeSessions: activeSessions.size });
});

app.post('/init-session', async (req, res) => {
    const { instanceId } = req.body;
    
    if (!instanceId) {
        return res.status(400).json({ error: 'instanceId manquant' });
    }

    console.log(`Recu demande init pour ${instanceId}`);
    
    // Verifier que l'instance existe dans Supabase
    const { data: instance, error: fetchError } = await supabase
        .from('instances')
        .select('id, status')
        .eq('id', instanceId)
        .single();

    if (fetchError || !instance) {
        console.error(`Instance ${instanceId} non trouvee:`, fetchError?.message);
        return res.status(404).json({ error: 'Instance non trouvee dans Supabase' });
    }

    // Lancer le processus WhatsApp
    startWhatsApp(instanceId).catch(err => {
        console.error("Erreur startWhatsApp:", err);
    });
    
    return res.json({ 
        status: 'initializing', 
        message: 'Demarrage en cours, QR code bientot disponible...',
        instanceId 
    });
});

app.post('/disconnect/:instanceId', async (req, res) => {
    const { instanceId } = req.params;
    
    if (activeSessions.has(instanceId)) {
        try {
            activeSessions.get(instanceId).end();
        } catch (e) {}
        activeSessions.delete(instanceId);
    }

    await supabase
        .from('instances')
        .update({ status: 'disconnected', qr_code: null })
        .eq('id', instanceId);

    res.json({ status: 'disconnected', instanceId });
});

// --- 4. DEMARRAGE ---
app.listen(PORT, () => {
    console.log(`Worker WhatsApp demarre sur le port ${PORT}`);
    console.log(`Supabase URL: ${SUPABASE_URL}`);
});
