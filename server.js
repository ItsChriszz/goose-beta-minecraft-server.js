
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;
const DOMAIN = 'beta.goosehosting.com';

// Validate environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PTERODACTYL_API_KEY',
  'PTERODACTYL_API_URL',
  'FRONTEND_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;

const app = express();

// Middleware configuration
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Helper functions
const generatePassword = (length = 16) => {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length }, () => 
    charset.charAt(Math.floor(Math.random() * charset.length))
    .join('');
};

const generateUsername = (email) => {
  const base = email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${base}${Math.floor(Math.random() * 1000)}`;
};

// Pterodactyl API functions
const createOrGetUser = async (email) => {
  try {
    // Check for existing user
    const { data } = await axios.get(`${PTERODACTYL_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const existingUser = data.data.find(u => u.attributes.email === email);
    if (existingUser) {
      return {
        userId: existingUser.attributes.id,
        username: existingUser.attributes.username,
        isNewUser: false
      };
    }

    // Create new user
    const username = generateUsername(email);
    const password = generatePassword();
    
    const { data: newUser } = await axios.post(`${PTERODACTYL_BASE}/users`, {
      email,
      username,
      first_name: 'Minecraft',
      last_name: 'Player',
      password
    }, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      userId: newUser.attributes.id,
      username,
      password,
      isNewUser: true
    };

  } catch (error) {
    console.error('Pterodactyl user error:', error.response?.data || error.message);
    throw error;
  }
};

const createPterodactylServer = async (session) => {
  try {
    const email = session.customer_details?.email || session.metadata?.customerEmail;
    if (!email) throw new Error('No customer email found');

    const user = await createOrGetUser(email);
    const { data: eggs } = await axios.get(`${PTERODACTYL_BASE}/nests/1/eggs`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const minecraftEgg = eggs.data.find(e => 
      e.attributes.name.toLowerCase().includes('minecraft'));
    if (!minecraftEgg) throw new Error('Minecraft egg not found');

    const { data: nodes } = await axios.get(`${PTERODACTYL_BASE}/nodes`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const nodeId = nodes.data[0].attributes.id;
    const { data: allocs } = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocs.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No available allocations');

    const metadata = session.metadata || {};
    const ram = parseInt(metadata.totalRam) || 4;

    const { data: server } = await axios.post(`${PTERODACTYL_BASE}/servers`, {
      name: metadata.serverName || `mc-${Date.now()}`,
      user: user.userId,
      egg: minecraftEgg.attributes.id,
      docker_image: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        VERSION: metadata.minecraftVersion || 'latest',
        SERVER_MEMORY: ram * 1024
      },
      limits: {
        memory: ram * 1024,
        disk: 5120,
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: 1,
        allocations: 1,
        backups: 3
      },
      allocation: {
        default: allocation.attributes.id
      }
    }, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      serverId: server.attributes.id,
      serverName: server.attributes.name,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port,
      username: user.username,
      password: user.isNewUser ? user.password : undefined,
      panelUrl: PTERODACTYL_BASE.replace('/api/application', '')
    };

  } catch (error) {
    console.error('Server creation failed:', error.response?.data || error.message);
    throw error;
  }
};

// API Endpoints
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { serverConfig } = req.body;
    
    if (!serverConfig?.serverName) {
      return res.status(400).json({ 
        error: 'Server name is required',
        status: 'invalid_request'
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: serverConfig.serverType ? 
              `${serverConfig.serverType} server` : 'Minecraft server'
          },
          unit_amount: 1000, // $10.00
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}`,
      metadata: {
        serverName: serverConfig.serverName,
        serverType: serverConfig.serverType || 'paper',
        minecraftVersion: serverConfig.minecraftVersion || 'latest',
        totalRam: String(serverConfig.totalRam || 4),
        customerEmail: serverConfig.customerEmail || ''
      }
    });

    res.json({ 
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ 
      error: error.message,
      status: 'server_error'
    });
  }
});

app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId.startsWith('cs_')) {
      return res.status(400).json({ 
        error: 'Invalid session ID format',
        status: 'invalid_id'
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ 
        status: 'payment_required',
        paymentStatus: session.payment_status
      });
    }

    if (session.metadata.serverCreated === 'true') {
      return res.json({
        status: 'ready',
        serverName: session.metadata.serverName,
        serverIp: session.metadata.serverIp,
        serverPort: session.metadata.serverPort,
        panelUrl: PTERODACTYL_BASE.replace('/api/application', '')
      });
    }

    const server = await createPterodactylServer(session);
    
    await stripe.checkout.sessions.update(sessionId, {
      metadata: {
        ...session.metadata,
        serverCreated: 'true',
        serverIp: server.serverIp,
        serverPort: server.serverPort
      }
    });

    res.json({
      status: 'ready',
      ...server
    });

  } catch (error) {
    console.error('Server details error:', error);
    
    if (error.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ 
        error: 'Session not found',
        status: 'not_found'
      });
    }
    
    res.status(500).json({ 
      error: error.message,
      status: 'server_error'
    });
  }
});

app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event: ${event.type}`);
  res.json({ received: true });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    domain: DOMAIN,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🦆 Goose Hosting API running on ${DOMAIN}:${PORT}`);
  console.log(`🔗 Pterodactyl: ${PTERODACTYL_BASE}`);
  console.log(`🌐 Frontend: ${process.env.FRONTEND_URL}`);
  console.log(`💳 Stripe mode: ${process.env.STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : 'LIVE'}`);
});
