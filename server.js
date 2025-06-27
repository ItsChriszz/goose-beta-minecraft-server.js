const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_SERVERS = 5; // Server capacity limit

/* ======================
   MEGA DEBUG CONFIG
   ====================== */
const DEBUG_MODE = process.env.DEBUG_MODE || true;
function debugLog(...args) {
  if (DEBUG_MODE) {
    console.log('[DEBUG]', ...args);
  }
}

/* ======================
   EXPRESS SETUP
   ====================== */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  debugLog(`\n=== INCOMING ${req.method} ${req.path} ===`);
  debugLog('Headers:', req.headers);
  debugLog('Body:', req.body);
  debugLog('Query:', req.query);
  next();
});

/* ======================
   CORS CONFIGURATION
   ====================== */
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://goosehosting.com',
    'https://www.goosehosting.com',
    'https://beta.goosehosting.com',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
};
app.use(cors(corsOptions));
debugLog('CORS Configured:', corsOptions);

/* ======================
   PTERODACTYL CONFIG
   ====================== */
const PTERODACTYL_BASE = process.env.PTERODACTYL_BASE || 'https://panel.goosehosting.com';
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
debugLog('Pterodactyl Config:', {
  base: PTERODACTYL_BASE,
  apiKey: PTERODACTYL_API_KEY ? '***REDACTED***' : 'MISSING'
});

/* ======================
   UTILITY FUNCTIONS
   ====================== */
function generateServerCredentials(customerEmail, serverName) {
  debugLog('Generating credentials for:', customerEmail);
  const password = generateRandomPassword(16);
  const username = (customerEmail?.split('@')[0] || 'server')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase() + '_' + Date.now().toString().slice(-4);
  
  debugLog('Generated Credentials:', { username, password: '***REDACTED***' });
  return { username, password, serverName };
}

function generateRandomPassword(length = 16) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  return Array.from({ length }, () => 
    charset.charAt(Math.floor(Math.random() * charset.length))
    .join('');
}

/* ======================
   PRECHECK ENDPOINT
   ====================== */
app.post('/precheck', async (req, res) => {
  console.group('\n🛂 SERVER CAPACITY PRECHECK');
  try {
    debugLog('Request Body:', req.body);
    const { nodeId } = req.body;
    
    if (!nodeId) {
      console.error('❌ Missing nodeId');
      return res.status(400).json({ 
        error: 'Node ID is required',
        received: req.body 
      });
    }

    console.log('🔄 Querying Pterodactyl for server count...');
    const startTime = Date.now();
    const serversResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    const responseTime = Date.now() - startTime;

    const currentServerCount = serversResponse.data.meta.pagination.total;
    const remainingCapacity = MAX_SERVERS - currentServerCount;
    
    console.log(`📊 Server Capacity: ${currentServerCount}/${MAX_SERVERS} (${remainingCapacity} remaining)`);
    debugLog('Full Response:', {
      status: serversResponse.status,
      time: `${responseTime}ms`,
      data: serversResponse.data
    });

    if (currentServerCount >= MAX_SERVERS) {
      console.error(`🚨 BLOCKED: At capacity (${currentServerCount}/${MAX_SERVERS})`);
      return res.json({
        success: false,
        message: `Server limit reached (${currentServerCount}/${MAX_SERVERS})`,
        serverCount: currentServerCount,
        serverLimit: MAX_SERVERS,
        remainingCapacity: 0
      });
    }

    console.log(`✅ APPROVED: ${remainingCapacity} slots available`);
    res.json({
      success: true,
      serverCount: currentServerCount,
      serverLimit: MAX_SERVERS,
      remainingCapacity,
      message: `${remainingCapacity} server slots available`
    });

  } catch (error) {
    console.error('💥 PRECHECK ERROR:', error);
    res.status(500).json({ 
      error: 'Capacity check failed',
      details: DEBUG_MODE ? {
        message: error.message,
        stack: error.stack,
        response: error.response?.data
      } : undefined
    });
  } finally {
    console.groupEnd();
  }
});

/* ======================
   CHECKOUT ENDPOINT
   ====================== */
app.post('/create-checkout-session', async (req, res) => {
  console.group('\n💰 CHECKOUT SESSION CREATION');
  try {
    debugLog('Full Request:', req.body);

    // 1. Capacity Check
    console.log('🔄 Verifying server capacity...');
    const serversResponse = await axios.get(`${PTERODACTYL_BASE}/api/application/servers`, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const currentServerCount = serversResponse.data.meta.pagination.total;
    const remainingCapacity = MAX_SERVERS - currentServerCount;
    
    console.log(`📊 Capacity: ${currentServerCount}/${MAX_SERVERS} (${remainingCapacity} remaining)`);
    debugLog('Capacity Response:', serversResponse.data);

    if (currentServerCount >= MAX_SERVERS) {
      console.error(`🚨 REJECTED: At capacity (${currentServerCount}/${MAX_SERVERS})`);
      return res.status(403).json({
        error: 'Server limit reached',
        serverCount: currentServerCount,
        serverLimit: MAX_SERVERS,
        remainingCapacity: 0,
        message: `Cannot deploy (${currentServerCount}/${MAX_SERVERS} servers in use)`
      });
    }

    // 2. Process Payment
    const { planId, billingCycle, finalPrice, serverConfig } = req.body;
    debugLog('Extracted:', { planId, billingCycle, finalPrice });

    console.log('💳 Creating Stripe session...');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(finalPrice * 100),
          recurring: {
            interval: billingCycle === 'annual' ? 'year' : 'month',
            interval_count: billingCycle === 'annual' ? 1 : 
                          billingCycle === 'semiannual' ? 6 :
                          billingCycle === 'quarterly' ? 3 : 1
          },
          product_data: {
            name: `${serverConfig.serverName} - ${planId} Plan`,
            description: `Minecraft Server (${billingCycle})`,
            metadata: {
              serverType: serverConfig.serverType,
              minecraftVersion: serverConfig.minecraftVersion
            }
          }
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/setup`,
      metadata: {
        serverName: serverConfig.serverName,
        serverType: serverConfig.serverType,
        planId,
        billingCycle,
        serverStatus: 'pending_payment',
        capacity: `${currentServerCount + 1}/${MAX_SERVERS}`
      }
    });

    console.log(`🎉 CREATED: Now ${currentServerCount + 1}/${MAX_SERVERS} servers will be in use`);
    debugLog('Stripe Session:', {
      id: session.id,
      url: session.url,
      amount: finalPrice
    });

    res.json({
      sessionId: session.id,
      url: session.url,
      capacity: {
        current: currentServerCount,
        limit: MAX_SERVERS,
        remaining: remainingCapacity - 1
      }
    });

  } catch (error) {
    console.error('💥 CHECKOUT ERROR:', error);
    res.status(500).json({ 
      error: 'Payment failed',
      details: DEBUG_MODE ? {
        message: error.message,
        stack: error.stack,
        stripeError: error.raw
      } : undefined
    });
  } finally {
    console.groupEnd();
  }
});

/* ======================
   DEBUG ENDPOINTS
   ====================== */
app.get('/debug/config', (req, res) => {
  debugLog('Debug config requested');
  res.json({
    env: {
      nodeEnv: process.env.NODE_ENV,
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
      pterodactyl: PTERODACTYL_API_KEY ? 'configured' : 'missing'
    },
    limits: {
      maxServers: MAX_SERVERS
    },
    timestamp: new Date().toISOString()
  });
});

app.post('/debug/echo', (req, res) => {
  debugLog('Echo request:', req.body);
  res.json({
    received: req.body,
    headers: req.headers,
    timestamp: new Date().toISOString()
  });
});

/* ======================
   SERVER STARTUP
   ====================== */
app.listen(PORT, () => {
  console.log('\n🦆 === GOOSE HOSTING BACKEND ===');
  console.log(`🌐 Port: ${PORT}`);
  console.log(`🔧 Debug Mode: ${DEBUG_MODE}`);
  console.log(`🚦 Server Limit: ${MAX_SERVERS}`);
  console.log('===============================');
  debugLog('Full Config:', {
    stripe: process.env.STRIPE_SECRET_KEY ? '***REDACTED***' : null,
    pterodactyl: PTERODACTYL_API_KEY ? '***REDACTED***' : null
  });
});
