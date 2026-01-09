const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const pino = require('pino');

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("ERREUR CRITIQUE: Variables SUPABASE manquantes.");
    process.exit(1);
}

console.log(`Connexion Supabase: ${SUPABASE_URL}`);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

const activeSessions = new Map();

app.use(cors());
app.use(express.json());

// --- GESTION AUTH SUPABASE ---
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

// --- MOTEUR WHATSAPP ---
const startWhatsApp = async (instanceId, phoneNumber = null) => {
    console.log(`Demarrage session pour: ${instanceId}${phoneNumber ? ` (phone: ${phoneNumber})` : ' (QR mode)'}`);
    
    // Éviter les sessions dupliquées
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
        printQRInTerminal: !phoneNumber, // Désactiver si mode téléphone
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Anti-crash config
        syncFullHistory: false, // Anti-crash: évite le téléchargement lourd
        connectTimeoutMs: 60000,
    });

    activeSessions.set(instanceId, sock);

    // Variable pour tracker si on a déjà reçu un QR/code
    let hasReceivedCode = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // MODE QR CODE
        if (qr && !phoneNumber) {
            console.log(`QR Code recu pour ${instanceId}!`);
            hasReceivedCode = true;
            const { error } = await supabase
                .from('instances')
                .update({ qr_code: qr, status: 'scanning' })
                .eq('id', instanceId);
            
            if (error) {
                console.error(`Erreur update QR:`, error.message);
            } else {
                console.log(`QR sauvegarde pour ${instanceId}`);
            }
        }

        // MODE TÉLÉPHONE - Demander le pairing code
        if (phoneNumber && !hasReceivedCode && connection !== 'open' && connection !== 'close') {
            try {
                console.log(`Demande de pairing code pour ${phoneNumber}...`);
                
                // Formater le numéro (retirer le + si présent)
                const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                
                const pairingCode = await sock.requestPairingCode(cleanPhone);
                console.log(`Pairing code obtenu: ${pairingCode}`);
                
                hasReceivedCode = true;
                
                // Sauvegarder le pairing code dans qr_code (il sera affiché en gros texte)
                const { error } = await supabase
                    .from('instances')
                    .update({ qr_code: pairingCode, status: 'scanning' })
                    .eq('id', instanceId);
                
                if (error) {
                    console.error(`Erreur sauvegarde pairing code:`, error.message);
                } else {
                    console.log(`Pairing code sauvegarde pour ${instanceId}`);
                }
            } catch (err) {
                console.error(`Erreur requestPairingCode:`, err.message);
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
                setTimeout(() => startWhatsApp(instanceId, phoneNumber), 3000);
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

// --- ROUTES API ---

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
    const { instanceId, phoneNumber } = req.body;
    
    if (!instanceId) {
        return res.status(400).json({ error: 'instanceId manquant' });
    }

    console.log(`Recu demande init pour ${instanceId}${phoneNumber ? ` avec phone ${phoneNumber}` : ''}`);
    
    // Vérifier que l'instance existe
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
    startWhatsApp(instanceId, phoneNumber || null).catch(err => {
        console.error("Erreur startWhatsApp:", err);
    });
    
    return res.json({ 
        status: 'initializing', 
        message: phoneNumber 
            ? 'Demande de pairing code en cours...'
            : 'Demarrage en cours, QR code bientot disponible...',
        instanceId,
        mode: phoneNumber ? 'phone' : 'qr'
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

// --- DEMARRAGE ---
app.listen(PORT, () => {
    console.log(`Worker WhatsApp demarre sur le port ${PORT}`);
    console.log(`Supabase URL: ${SUPABASE_URL}`);
});
