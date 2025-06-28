import * as z from "zod/v4";   // import Zod
var express = require('express'); // 1. Import express first
var app = express();              // 2. Then call it
app.use(express.json());         // 3. Middleware setup


//zod data validation 
const ServerData = z.object({
    planId: z.string(),
    billingCycle: z.string(),
    finalPrice: z.number(),
    serverConfig: z.object({
      serverName: z.string().min(1),
      planId: z.string(),
      serverType: z.enum(['vanilla', 'paper', 'spigot', 'fabric', 'forge']),
      minecraftVersion: z.string(),
      totalRam: z.number().min(1),
      maxPlayers: z.number().min(1),
      viewDistance: z.number().min(1),
      enableWhitelist: z.boolean(),
      enablePvp: z.boolean(),
      selectedPlugins: z.array(z.string()),
      totalCost: z.number().min(0),
      customerEmail: z.string().optional(),
      timestamp: z.string() // ISO string, can also use z.string().datetime() in newer versions
    })
  });

//middleware function

//function to check if server is full


//function to block if request is missing params

app.post('/api/create-checkout-session', (req, res) => {
    try {
      const validated = ServerData.parse(req.body);
  
      console.log('✅ Valid data received:');
      console.dir(validated, { depth: null });
  
      res.status(200).json({ message: 'Data is valid!', serverName: validated.serverConfig.serverName });
    } catch (err) {
      console.error('❌ Validation failed:', err.errors);
      res.status(400).json({
        error: 'Validation failed',
        details: err.errors
      });
    }
  });

  //defining port

  const PORT = process.env.PORT || 3001;

/* ======================
   SERVER STARTUP
   ====================== */
   app.listen(PORT, () => {
    console.log('\n🦆 === GOOSE HOSTING BACKEND ===');
    console.log(`🌐 Port: ${PORT}`);
    // console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
    // console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'Ready' : 'Disabled'}`);
    // console.log(`🦅 Pterodactyl: ${PTERODACTYL_API_KEY ? 'Connected' : 'Disabled'}`);
    // console.log(`🚦 Server Limit: ${MAX_SERVERS}`);
    console.log('===============================\n');
  });