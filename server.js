require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware - Allow all CORS for development
// Add CORS headers globally
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  next();
});
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Enhanced error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message });
});

// Pterodactyl Server Creation
const createPterodactylServer = async (session) => {
  try {
    const customerEmail = session.customer_details?.email;
    if (!customerEmail) throw new Error("No email associated with payment");

    // Fetch required resources
    const [user, egg, allocation] = await Promise.all([
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/users?filter=${encodeURIComponent(customerEmail)}`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nests/1/eggs?filter=name=Minecraft%20Java`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      }),
      axios.get(`${process.env.PTERODACTYL_URL}/api/application/nodes/1/allocations`, {
        headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` }
      })
    ]);

    const freeAlloc = allocation.data.data.find(a => !a.attributes.assigned);
    if (!freeAlloc) throw new Error("No server capacity available");

    const { data } = await axios.post(
      `${process.env.PTERODACTYL_URL}/api/application/servers`,
      {
        name: session.metadata.serverName,
        user: user.data.data[0].attributes.id,
        egg: egg.data.data[0].attributes.id,
        docker_image: egg.data.data[0].attributes.docker_image,
        startup: "java -Xms128M -Xmx${session.metadata.totalRam * 1024}M -jar server.jar nogui",
        environment: {
          EULA: "TRUE",
          SERVER_JARFILE: "server.jar",
          VERSION: session.metadata.minecraftVersion
        },
        limits: {
          memory: session.metadata.totalRam * 1024,
          disk: 1024 * 5,
          cpu: 100
        },
        allocation: {
          default: freeAlloc.attributes.id
        }
      },
      { headers: { Authorization: `Bearer ${process.env.PTERODACTYL_KEY}` } }
    );

    return {
      serverId: data.attributes.id,
      identifier: data.attributes.identifier,
      ip: freeAlloc.attributes.ip,
      port: freeAlloc.attributes.port
    };
  } catch (error) {
    console.error("Deployment failed:", error);
    await stripe.checkout.sessions.update(session.id, {
      metadata: {
        ...session.metadata,
        deploymentError: error.message,
        failedAt: new Date().toISOString()
      }
    });
    throw error;
  }
};

// Stripe Webhook
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log(`Processing payment for ${session.customer_details?.email}`);
      
      const server = await createPterodactylServer(session);
      console.log(`Server created: ${server.ip}:${server.port}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Create Checkout Session
// Update the create-checkout-session endpoint
// In your backend route handler
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, serverConfig } = req.body;

    // Create Stripe session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Minecraft Server - ${serverConfig.serverName}`,
            description: `${serverConfig.serverType} ${serverConfig.minecraftVersion}`
          },
          unit_amount: Math.round(serverConfig.totalCost * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      metadata: serverConfig
    });

    // REQUIRED: Verify the URL exists
    if (!session.url) {
      throw new Error('Stripe did not generate a checkout URL');
    }

    // Return BOTH fields
    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url // THIS MUST BE INCLUDED
    });

  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({
      error: err.message,
      details: err.type || null
    });
  }
});

    // Create Stripe Price on the fly if using dynamic pricing
    const price = await stripe.prices.create({
      unit_amount: Math.round(serverConfig.totalCost * 100),
      currency: 'usd',
      product_data: {
        name: `Minecraft Server - ${serverConfig.serverName}`,
        description: `${serverConfig.serverType || 'Vanilla'} ${serverConfig.minecraftVersion || 'Latest'}`
      },
      recurring: { interval: 'month' }
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: price.id,
        quantity: 1,
      }],
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancel`,
      metadata: serverConfig,
      customer_email: serverConfig.customerEmail || 'customer@example.com' // Fallback email
    });

    console.log('Stripe session created:', {
      id: session.id,
      url: session.url,
      amount: session.amount_total
    });

    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }

    res.json({ 
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url 
    });

  } catch (err) {
    console.error('Stripe session creation failed:', {
      error: err.message,
      stack: err.stack,
      type: err.type,
      raw: err.raw ? err.raw.message : null
    });
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to create payment session',
      details: {
        message: err.message,
        type: err.type
      }
    });
  }
});

// Deployment Status Check
app.get('/deployment-status/:sessionId', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId, {
      expand: ['customer']
    });

    res.json({
      status: session.metadata.deploymentError ? 'failed' : 'completed',
      customerEmail: session.customer_details?.email,
      ...session.metadata
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS enabled for all origins`);
  console.log(`Stripe webhook URL: ${process.env.FRONTEND_URL}/webhook`);
});
