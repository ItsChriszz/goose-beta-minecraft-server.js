require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');

const PORT = process.env.PORT || 3001;

// Validate required environment variables
const requiredEnvVars = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PTERODACTYL_API_KEY',
  'PTERODACTYL_API_URL'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ ${envVar} environment variable is required`);
    process.exit(1);
  }
}

const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;

const app = express();

// CORS Configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());
app.use(cors(corsOptions));

// Helper Functions
function generatePassword(length = 12) {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

function generateUsername(email) {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${base}${random}`;
}

// Pterodactyl API Functions
async function createOrGetUser(email, firstName = 'Player', lastName = 'Goose') {
  try {
    // Check if user exists
    const usersRes = await axios.get(`${PTERODACTYL_BASE}/users`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const existingUser = usersRes.data.data.find(u => u.attributes.email === email);
    if (existingUser) {
      return {
        userId: existingUser.attributes.id,
        username: existingUser.attributes.username,
        email: existingUser.attributes.email,
        isNewUser: false
      };
    }

    // Create new user
    const username = generateUsername(email);
    const password = generatePassword();
    
    const userData = {
      email,
      username,
      first_name: firstName,
      last_name: lastName,
      password
    };

    const createUserRes = await axios.post(`${PTERODACTYL_BASE}/users`, userData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });

    const newUser = createUserRes.data.attributes;
    return {
      userId: newUser.id,
      username: newUser.username,
      email: newUser.email,
      password,
      isNewUser: true
    };
  } catch (err) {
    console.error('❌ Failed to create/get user:', err.message);
    if (err.response) console.error('Response data:', err.response.data);
    throw err;
  }
}

async function fetchPterodactylMeta(userId) {
  try {
    // Get Minecraft egg
    const eggsRes = await axios.get(`${PTERODACTYL_BASE}/nests/1/eggs`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const minecraftEgg = eggsRes.data.data.find(e => e.attributes.name.toLowerCase().includes('minecraft'));
    if (!minecraftEgg) throw new Error('Minecraft Java egg not found.');

    // Get node and allocation
    const nodesRes = await axios.get(`${PTERODACTYL_BASE}/nodes`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const nodeId = nodesRes.data.data[0].attributes.id;
    const allocRes = await axios.get(`${PTERODACTYL_BASE}/nodes/${nodeId}/allocations`, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        Accept: 'application/json'
      }
    });

    const allocation = allocRes.data.data.find(a => !a.attributes.assigned);
    if (!allocation) throw new Error('No free allocation found.');

    return {
      userId,
      eggId: minecraftEgg.attributes.id,
      dockerImage: minecraftEgg.attributes.docker_image,
      startup: minecraftEgg.attributes.startup,
      allocationId: allocation.attributes.id,
      serverIp: allocation.attributes.ip,
      serverPort: allocation.attributes.port
    };
  } catch (err) {
    console.error('❌ Failed to fetch Pterodactyl meta:', err.message);
    throw err;
  }
}

async function createPterodactylServer(session) {
  try {
    const customerEmail = session.customer_details?.email || session.metadata.customerEmail;
    if (!customerEmail) throw new Error('No customer email found');

    const userInfo = await createOrGetUser(customerEmail);
    const config = await fetchPterodactylMeta(userInfo.userId);

    // Extract server configuration from metadata
    const metadata = session.metadata;
    const serverName = metadata.serverName || `GooseServer-${Date.now()}`;
    const serverType = metadata.serverType || 'paper';
    const minecraftVersion = metadata.minecraftVersion || 'latest';
    const planId = metadata.planId || 'pro';
    const totalRam = parseInt(metadata.totalRam) || 4;

    // Create server
    const serverData = {
      name: serverName,
      user: config.userId,
      egg: config.eggId,
      docker_image: config.dockerImage,
      startup: config.startup,
      environment: {
        SERVER_JARFILE: 'server.jar',
        BUILD_NUMBER: 'latest',
        VERSION: minecraftVersion,
        SERVER_MEMORY: totalRam * 1024
      },
      limits: {
        memory: totalRam * 1024,
        swap: 0,
        disk: Math.max(5000, totalRam * 1000),
        io: 500,
        cpu: 0
      },
      feature_limits: {
        databases: planId === 'starter' ? 1 : planId === 'pro' ? 2 : 5,
        allocations: 1,
        backups: planId === 'starter' ? 3 : planId === 'pro' ? 10 : 25
      },
      allocation: {
        default: config.allocationId
      }
    };

    const response = await axios.post(`${PTERODACTYL_BASE}/servers`, serverData, {
      headers: {
        Authorization: `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'Application/vnd.pterodactyl.v1+json'
      }
    });

    const server = response.data.attributes;
    return {
      serverId: server.id,
      serverUuid: server.uuid,
      serverIdentifier: server.identifier,
      serverName,
      serverIp: config.serverIp,
      serverPort: config.serverPort,
      serverType,
      minecraftVersion,
      planId,
      customerEmail,
      username: userInfo.username,
      password: userInfo.isNewUser ? userInfo.password : undefined,
      panelUrl: PTERODACTYL_BASE.replace('/api/application', ''),
      createdAt: new Date().toISOString()
    };
  } catch (err) {
    console.error('❌ Server creation failed:', err.message);
    if (err.response) console.error('Response data:', err.response.data);
    throw err;
  }
}

// API Endpoints
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, serverConfig } = req.body;

    if (!serverConfig?.serverName || !serverConfig?.serverType) {
      return res.status(400).json({ error: 'Missing required server configuration' });
    }

    const metadata = {
      serverName: serverConfig.serverName,
      planId: planId || 'pro',
      serverType: serverConfig.serverType,
      minecraftVersion: serverConfig.minecraftVersion || 'latest',
      totalRam: String(serverConfig.totalRam || 4),
      customerEmail: serverConfig.customerEmail || ''
    };

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${serverConfig.serverType} server`
          },
          unit_amount: Math.round((serverConfig.totalCost || 10) * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/setup`,
      metadata
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('❌ Checkout session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/server-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription']
    });

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ 
        status: 'payment_pending',
        message: 'Payment not completed'
      });
    }

    if (session.metadata.serverCreated === 'true') {
      return res.json({
        status: 'ready',
        message: 'Server already created',
        details: {
          serverName: session.metadata.serverName,
          serverType: session.metadata.serverType,
          minecraftVersion: session.metadata.minecraftVersion,
          customerEmail: session.customer_details?.email || session.metadata.customerEmail
        }
      });
    }

    const serverDetails = await createPterodactylServer(session);
    await stripe.checkout.sessions.update(sessionId, {
      metadata: { ...session.metadata, serverCreated: 'true' }
    });

    res.json({
      status: 'ready',
      message: 'Server created successfully',
      details: serverDetails
    });
  } catch (err) {
    console.error('❌ Error in server-details:', err.message);
    if (err.type === 'StripeInvalidRequestError') {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.status(500).json({ error: err.message });
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
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Received event: ${event.type}`);
  res.json({ received: true });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🦆 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Pterodactyl: ${PTERODACTYL_BASE}`);
});
