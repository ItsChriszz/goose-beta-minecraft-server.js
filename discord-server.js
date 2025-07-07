// discord-server.js - Discord Bot Hosting Server
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Initialize Stripe with error handling
let stripe;
try {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('⚠️ STRIPE_SECRET_KEY not found in environment variables');
    stripe = null;
  } else {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('✅ Stripe initialized successfully');
  }
} catch (error) {
  console.error('❌ Failed to initialize Stripe:', error.message);
  stripe = null;
}

const app = express();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = './uploads/discord-bots';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.js', '.json', '.py', '.ts', '.zip', '.tar.gz'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: .js, .json, .py, .ts, .zip, .tar.gz'));
    }
  }
});

// Enhanced CORS configuration
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://beta.goosehosting.com',
    'https://goosehosting.com',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Environment validation
const validateEnvVars = () => {
  const requiredVars = [
    'PTERODACTYL_API_URL',
    'PTERODACTYL_API_KEY',
    'STRIPE_SECRET_KEY',
    'PTERODACTYL_DISCORD_NODE_ID',
    'PTERODACTYL_DISCORD_EGG_ID'
  ];
  
  const missingRequired = requiredVars.filter(varName => !process.env[varName]);
  if (missingRequired.length > 0) {
    console.error('❌ Missing required environment variables:', missingRequired.join(', '));
    process.exit(1);
  }
};

validateEnvVars();

// Pterodactyl configuration
const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
const nodeId = process.env.PTERODACTYL_DISCORD_NODE_ID;
const discordEggId = process.env.PTERODACTYL_DISCORD_EGG_ID;

// Discord Bot runtime configurations
const getDiscordBotRuntime = (language, framework) => {
  const runtimes = {
    'nodejs': {
      'discord.js': {
        image: 'ghcr.io/pterodactyl/yolks:nodejs_18',
        startup: 'node index.js',
        defaultFiles: {
          'index.js': `const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => {
  console.log('Bot is online!');
});

client.on('messageCreate', message => {
  if (message.content === '!ping') {
    message.reply('Pong!');
  }
});

client.login(process.env.DISCORD_TOKEN);`,
          'package.json': `{
  "name": "goose-discord-bot",
  "version": "1.0.0",
  "description": "Discord bot hosted on GoosePanel",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "discord.js": "^14.14.1"
  }
}`
        }
      },
      'eris': {
        image: 'ghcr.io/pterodactyl/yolks:nodejs_18',
        startup: 'node index.js',
        defaultFiles: {
          'index.js': `const Eris = require('eris');
const bot = new Eris(process.env.DISCORD_TOKEN);

bot.on('ready', () => {
  console.log('Bot is ready!');
});

bot.on('messageCreate', (msg) => {
  if (msg.content === '!ping') {
    bot.createMessage(msg.channel.id, 'Pong!');
  }
});

bot.connect();`,
          'package.json': `{
  "name": "goose-discord-bot",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "eris": "^0.17.2"
  }
}`
        }
      }
    },
    'python': {
      'discord.py': {
        image: 'ghcr.io/pterodactyl/yolks:python_3.11',
        startup: 'python main.py',
        defaultFiles: {
          'main.py': `import discord
import os
from discord.ext import commands

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix='!', intents=intents)

@bot.event
async def on_ready():
    print(f'{bot.user} has landed!')

@bot.command()
async def ping(ctx):
    await ctx.send('Pong!')

bot.run(os.getenv('DISCORD_TOKEN'))`,
          'requirements.txt': 'discord.py>=2.3.2'
        }
      },
      'py-cord': {
        image: 'ghcr.io/pterodactyl/yolks:python_3.11',
        startup: 'python main.py',
        defaultFiles: {
          'main.py': `import discord
import os

intents = discord.Intents.default()
intents.message_content = True

bot = discord.Bot(intents=intents)

@bot.event
async def on_ready():
    print(f'{bot.user} is ready and online!')

@bot.slash_command(name="ping", description="Sends the bot's latency.")
async def ping(ctx):
    await ctx.respond(f"Pong! Latency is {bot.latency}ms")

bot.run(os.getenv('DISCORD_TOKEN'))`,
          'requirements.txt': 'py-cord>=2.4.1'
        }
      }
    },
    'java': {
      'jda': {
        image: 'ghcr.io/pterodactyl/yolks:java_17',
        startup: 'java -jar bot.jar',
        defaultFiles: {
          'Main.java': `import net.dv8tion.jda.api.JDABuilder;
import net.dv8tion.jda.api.events.message.MessageReceivedEvent;
import net.dv8tion.jda.api.hooks.ListenerAdapter;

public class Main extends ListenerAdapter {
    public static void main(String[] args) {
        JDABuilder.createDefault(System.getenv("DISCORD_TOKEN"))
                .addEventListeners(new Main())
                .build();
    }

    @Override
    public void onMessageReceived(MessageReceivedEvent event) {
        if (event.getMessage().getContentRaw().equals("!ping")) {
            event.getChannel().sendMessage("Pong!").queue();
        }
    }
}`,
          'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.goosehosting</groupId>
    <artifactId>discord-bot</artifactId>
    <version>1.0-SNAPSHOT</version>
    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
    </properties>
    <dependencies>
        <dependency>
            <groupId>net.dv8tion</groupId>
            <artifactId>JDA</artifactId>
            <version>5.0.0-beta.18</version>
        </dependency>
    </dependencies>
</project>`
        }
      }
    },
    'csharp': {
      'discord.net': {
        image: 'ghcr.io/pterodactyl/yolks:dotnet_6',
        startup: 'dotnet run',
        defaultFiles: {
          'Program.cs': `using Discord;
using Discord.WebSocket;

public class Program
{
    private DiscordSocketClient _client;

    public static Task Main(string[] args) => new Program().MainAsync();

    public async Task MainAsync()
    {
        _client = new DiscordSocketClient();
        
        _client.Log += Log;
        _client.MessageReceived += MessageReceived;

        var token = Environment.GetEnvironmentVariable("DISCORD_TOKEN");
        await _client.LoginAsync(TokenType.Bot, token);
        await _client.StartAsync();

        await Task.Delay(-1);
    }

    private async Task MessageReceived(SocketMessage message)
    {
        if (message.Content == "!ping")
        {
            await message.Channel.SendMessageAsync("Pong!");
        }
    }

    private Task Log(LogMessage msg)
    {
        Console.WriteLine(msg.ToString());
        return Task.CompletedTask;
    }
}`,
          'Bot.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Discord.Net" Version="3.12.0" />
  </ItemGroup>
</Project>`
        }
      }
    }
  };

  return runtimes[language]?.[framework] || runtimes['nodejs']['discord.js'];
};

// Enhanced Pterodactyl API request helper
const pterodactylRequest = async (method, endpoint, data = null) => {
  const config = {
    method,
    url: `${PTERODACTYL_BASE}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };
  
  if (data) {
    config.data = data;
  }
  
  console.log(`📡 ${method} ${config.url}`);
  
  try {
    const response = await axios(config);
    console.log(`✅ ${method} ${endpoint} - Status: ${response.status}`);
    return response;
  } catch (error) {
    const errorDetails = {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    };
    console.error(`❌ ${method} ${endpoint} - Error:`, errorDetails);
    throw new Error(errorDetails.message || `Pterodactyl API request failed: ${endpoint}`);
  }
};

// Username and password generators
function generateUsernameFromEmail(email) {
  let username = email.split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 10);

  if (username.length < 4) {
    username += 'bot';
  }

  const suffix = Math.floor(Math.random() * 9000 + 1000);
  return `${username}${suffix}`.slice(0, 16);
}

function generateRandomPassword(length = 16) {
  const chars = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    numbers: '0123456789',
    symbols: '!@#$%^&*'
  };
  const allChars = Object.values(chars).join('');

  let password = '';
  password += chars.lower[crypto.randomInt(0, chars.lower.length)];
  password += chars.upper[crypto.randomInt(0, chars.upper.length)];
  password += chars.numbers[crypto.randomInt(0, chars.numbers.length)];
  password += chars.symbols[crypto.randomInt(0, chars.symbols.length)];

  for (let i = password.length; i < length; i++) {
    password += allChars[crypto.randomInt(0, allChars.length)];
  }

  return password.split('').sort(() => 0.5 - Math.random()).join('');
}

// Enhanced Create User function
const CreateUser = async (email) => {
  if (!email || typeof email !== 'string') {
    throw new Error('Email must be a valid string');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }
  email = email.trim().toLowerCase();

  try {
    console.log(`Starting user creation for: ${email}`);

    // Check for existing user
    const searchUrl = `${PTERODACTYL_BASE}/users?filter[email]=${encodeURIComponent(email)}`;
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    if (searchResponse.data.data.length > 0) {
      const user = searchResponse.data.data[0].attributes;
      console.log(`User exists: ${user.username}`);
      return {
        success: true,
        userId: user.id.toString(),
        username: user.username,
        email: user.email,
        existing: true,
        admin: user.root_admin,
        password: null
      };
    }

    // Generate credentials and create user
    const username = generateUsernameFromEmail(email);
    const password = generateRandomPassword(16);
    console.log(`Generated credentials - Username: ${username}`);

    const createUrl = `${PTERODACTYL_BASE}/users`;
    const userData = {
      email: email,
      username: username,
      first_name: username.split('.')[0] || username,
      last_name: 'BotUser',
      password: password,
      root_admin: false,
      language: 'en'
    };

    console.log(`Creating user at: ${createUrl}`);
    const createResponse = await axios.post(createUrl, userData, {
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!createResponse.data?.attributes) {
      throw new Error('Invalid API response format');
    }

    console.log(`User created successfully: ${createResponse.data.attributes.username}`);
    return {
      success: true,
      userId: createResponse.data.attributes.id.toString(),
      username: createResponse.data.attributes.username,
      email: createResponse.data.attributes.email,
      password: password,
      existing: false,
      admin: createResponse.data.attributes.root_admin
    };

  } catch (error) {
    console.error('User creation failed:', error.message);
    throw new Error(`User creation failed: ${error.message}`);
  }
};

// In-memory session store
const sessionCredentialsStore = new Map();

// Enhanced Discord Bot Server creation
async function createDiscordBotServer(session) {
  if (!nodeId || !discordEggId) {
    throw new Error('Discord bot creation requires PTERODACTYL_DISCORD_NODE_ID and PTERODACTYL_DISCORD_EGG_ID');
  }

  try {
    console.log('🤖 Starting Discord bot server creation process');
    
    const customerEmail = session.customer_details?.email || 
                        session.customer_email || 
                        session.metadata?.customerEmail ||
                        session.customer?.email;
    
    if (!customerEmail || !customerEmail.includes('@')) {
      throw new Error('Valid customer email is required');
    }
    
    console.log('📧 Using customer email:', customerEmail);
    
    // STEP 1: Create or find user
    const userResult = await CreateUser(customerEmail);
    console.log('👤 User result:', {
      id: userResult.userId,
      username: userResult.username,
      existing: userResult.existing,
      hasPassword: !!userResult.password
    });
    
    // STEP 2: Extract bot settings from session metadata
    const botName = session.metadata?.botName || `Bot-${Date.now()}`;
    const totalRam = parseInt(session.metadata?.totalRam) || 512; // MB for Discord bots
    const language = session.metadata?.language || 'nodejs';
    const framework = session.metadata?.framework || 'discord.js';
    const planType = session.metadata?.plan || 'starter';
    
    // STEP 3: Get runtime configuration
    const runtime = getDiscordBotRuntime(language, framework);
    console.log('🔧 Runtime configuration:', runtime);
    
    // STEP 4: Get available allocation
    const allocRes = await pterodactylRequest('GET', `/nodes/${nodeId}/allocations`);
    const availableAllocations = allocRes.data.data.filter(a => !a.attributes.assigned);
    
    if (availableAllocations.length === 0) {
      throw new Error('No available server ports on this node');
    }
    
    const allocation = availableAllocations[0];
    console.log(`🎯 Using allocation: ${allocation.attributes.id}`);
    
    // STEP 5: Create Discord bot server
    const serverData = {
      name: botName,
      user: parseInt(userResult.userId),
      egg: parseInt(discordEggId),
      docker_image: runtime.image,
      startup: runtime.startup,
      environment: {
        DISCORD_TOKEN: session.metadata?.discordToken || '',
        BOT_NAME: botName,
        LANGUAGE: language,
        FRAMEWORK: framework,
        AUTO_RESTART: 'true'
      },
      limits: {
        memory: totalRam,
        swap: 0,
        disk: totalRam * 2, // 2x RAM for disk space
        io: 500,
        cpu: planType === 'starter' ? 50 : planType === 'pro' ? 100 : 200 // CPU percentage
      },
      feature_limits: {
        databases: planType === 'starter' ? 1 : planType === 'pro' ? 2 : 5,
        allocations: 1,
        backups: planType === 'starter' ? 2 : planType === 'pro' ? 5 : 10
      },
      allocation: {
        default: allocation.attributes.id
      }
    };
    
    console.log('🔨 Creating Discord bot server with configuration:', {
      name: serverData.name,
      image: serverData.docker_image,
      language: language,
      framework: framework,
      plan: planType
    });
    
    const response = await pterodactylRequest('POST', '/servers', serverData);
    
    const serverId = response.data.attributes.id;
    const serverUuid = response.data.attributes.uuid;
    
    console.log('🎉 Discord bot server created successfully:', {
      id: serverId,
      uuid: serverUuid,
      language: language,
      framework: framework
    });
    
    // STEP 6: Upload default files
    try {
      await uploadDefaultFiles(serverUuid, runtime.defaultFiles);
      console.log('📁 Default bot files uploaded successfully');
    } catch (uploadError) {
      console.warn('⚠️ Failed to upload default files:', uploadError.message);
    }
    
    // STEP 7: Prepare credentials and server info
    const serverInfo = {
      serverId: serverId,
      serverUuid: serverUuid,
      botType: 'discord',
      pterodactylUserId: userResult.userId,
      pterodactylUsername: userResult.username,
      ownerEmail: customerEmail,
      createdAt: new Date().toISOString(),
      userStatus: userResult.existing ? 'existing' : 'new',
      language: language,
      framework: framework,
      dockerImage: runtime.image,
      planType: planType,
      ramAllocation: totalRam
    };

    // Only add credentials for new users
    if (!userResult.existing && userResult.password) {
      serverInfo.serverUsername = userResult.username;
      serverInfo.serverPassword = userResult.password;
      serverInfo.ftpHost = 'ftp.goosehosting.com';
      serverInfo.ftpPort = '21';
      serverInfo.ftpUsername = userResult.username;
      serverInfo.ftpPassword = userResult.password;
    }

    // STEP 8: Try to update Stripe session
    if (stripe && session.id) {
      try {
        console.log('🔄 Attempting to update Stripe session metadata...');
        
        const updateMetadata = {
          ...session.metadata,
          ...serverInfo
        };

        await stripe.checkout.sessions.update(session.id, {
          metadata: updateMetadata
        });
        
        console.log('✅ Updated Stripe session with credentials');
      } catch (stripeError) {
        console.warn('⚠️ Failed to update Stripe session, storing in memory:', stripeError.message);
        sessionCredentialsStore.set(session.id, {
          ...session.metadata,
          ...serverInfo
        });
        console.log('💾 Stored credentials in memory store as fallback');
      }
    } else {
      console.warn('⚠️ Stripe not available, storing credentials in memory');
      sessionCredentialsStore.set(session.id, {
        ...session.metadata,
        ...serverInfo
      });
    }
    
    return {
      success: true,
      serverId,
      serverUuid,
      botType: 'discord',
      user: {
        id: userResult.userId,
        email: customerEmail,
        username: userResult.username,
        password: userResult.password,
        existing: userResult.existing
      },
      credentials: serverInfo
    };
    
  } catch (err) {
    console.error('❌ Discord bot server creation failed:', err.message);
    throw err;
  }
}

// Upload default files to the server
async function uploadDefaultFiles(serverUuid, files) {
  if (!files || typeof files !== 'object') return;
  
  for (const [filename, content] of Object.entries(files)) {
    try {
      await pterodactylRequest('POST', `/servers/${serverUuid}/files/write`, {
        root: '/',
        files: [{
          name: filename,
          content: content
        }]
      });
      console.log(`📄 Created file: ${filename}`);
    } catch (error) {
      console.warn(`⚠️ Failed to create file ${filename}:`, error.message);
      throw error;
    }
  }
}

// API Endpoints with /api prefix for better organization

// Get session details endpoint
app.get('/api/discord-session-details/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    console.log(`\n🔍 Fetching Discord bot session details for: ${sessionId}`);

    let session = null;
    let metadata = {};

    if (stripe) {
      try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
        metadata = session.metadata || {};
        console.log('📋 Session found from Stripe:', {
          id: session.id,
          status: session.payment_status,
          email: session.customer_details?.email,
          hasCredentials: !!(metadata.serverUsername),
          hasServer: !!(metadata.serverId)
        });
      } catch (stripeError) {
        console.warn('⚠️ Failed to retrieve from Stripe:', stripeError.message);
      }
    }

    const memoryData = sessionCredentialsStore.get(sessionId);
    if (memoryData) {
      console.log('💾 Found additional data in memory store');
      metadata = { ...metadata, ...memoryData };
    }

    if (!session && !memoryData) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session && memoryData) {
      session = {
        id: sessionId,
        payment_status: 'paid',
        customer_details: { email: memoryData.ownerEmail },
        metadata: memoryData
      };
    }

    if (session.payment_status === 'paid' && !metadata.serverId) {
      console.log('💰 Payment confirmed, creating Discord bot server...');
      
      try {
        const serverResult = await createDiscordBotServer(session);
        console.log('🎉 Discord bot server created successfully');
        
        metadata = { ...metadata, ...serverResult.credentials };
        
        return res.json({
          success: true,
          session: {
            id: session.id,
            status: session.payment_status,
            customer_email: session.customer_details?.email,
            metadata: metadata
          },
          server: {
            id: serverResult.serverId,
            uuid: serverResult.serverUuid,
            type: 'discord-bot',
            user: serverResult.user
          },
          message: 'Discord bot server created successfully'
        });
        
      } catch (serverError) {
        console.error('❌ Discord bot server creation failed:', serverError.message);
        
        return res.json({
          success: false,
          session: {
            id: session.id,
            status: session.payment_status,
            customer_email: session.customer_details?.email,
            metadata: metadata
          },
          error: `Discord bot server creation failed: ${serverError.message}`,
          message: 'Payment successful but server creation failed'
        });
      }
    }

    return res.json({
      success: true,
      session: {
        id: session.id,
        status: session.payment_status,
        customer_email: session.customer_details?.email,
        metadata: metadata
      },
      message: session.payment_status === 'paid' ? 'Discord bot server already exists' : 'Payment pending'
    });

  } catch (error) {
    console.error('❌ Discord session details error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create Discord bot checkout session endpoint
app.post('/api/create-discord-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const botConfig = req.body.botConfig || req.body;
    const planId = req.body.planId || req.body.plan;
    const billingCycle = req.body.billingCycle || 'monthly';

    const { 
      botName, 
      language,
      framework,
      totalRam,
      totalCost,
      monthlyCost,
      effectiveMonthlyRate,
      discount,
      savings,
      discordToken
    } = botConfig;

    if (!botName || !planId || (!totalCost && !monthlyCost)) {
      return res.status(400).json({ 
        error: 'Missing required fields: botName, plan, and totalCost/monthlyCost are required'
      });
    }

    console.log('💳 Creating Discord bot Stripe checkout session:', {
      botName,
      plan: planId,
      billingCycle,
      totalCost,
      monthlyCost,
      effectiveMonthlyRate,
      language,
      framework
    });

    // Map billing cycles to Stripe intervals
    const billingIntervalMap = {
      'monthly': { interval: 'month', interval_count: 1 },
      'quarterly': { interval: 'month', interval_count: 3 },
      'semiannual': { interval: 'month', interval_count: 6 },
      'annual': { interval: 'year', interval_count: 1 }
    };

    const stripeInterval = billingIntervalMap[billingCycle] || billingIntervalMap['monthly'];
    
    // Calculate the correct amount based on billing cycle
    let unitAmount;
    let description;
    
    if (billingCycle === 'monthly') {
      unitAmount = Math.round((monthlyCost || effectiveMonthlyRate || 3.99) * 100);
      description = `Discord Bot (${language}/${framework}) - Monthly`;
    } else {
      unitAmount = Math.round((totalCost || monthlyCost || 3.99) * 100);
      const periodNames = {
        'quarterly': '3 months',
        'semiannual': '6 months', 
        'annual': '12 months'
      };
      description = `Discord Bot (${language}/${framework}) - ${periodNames[billingCycle] || billingCycle}`;
    }

    console.log('💰 Stripe pricing calculation:', {
      billingCycle,
      stripeInterval,
      unitAmount: unitAmount / 100,
      description
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${botName} - ${planId.toUpperCase()} Discord Bot`,
            description: description
          },
          recurring: {
            interval: stripeInterval.interval,
            interval_count: stripeInterval.interval_count
          },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      mode: 'subscription',
      success_url: `https://beta.goosehosting.com/discord-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://beta.goosehosting.com/cancel`,
      metadata: {
        botName: botName || 'Unnamed Bot',
        plan: planId || 'starter',
        language: language || 'nodejs',
        framework: framework || 'discord.js',
        totalRam: (totalRam || 512).toString(),
        billingCycle: billingCycle,
        totalCost: (totalCost || 0).toString(),
        monthlyCost: (monthlyCost || 0).toString(),
        effectiveMonthlyRate: (effectiveMonthlyRate || 0).toString(),
        discount: (discount || 0).toString(),
        savings: (savings || 0).toString(),
        discordToken: discordToken || '',
        serviceType: 'discord-bot'
      }
    });

    console.log('✅ Discord bot Stripe session created:', {
      sessionId: session.id,
      billingCycle,
      interval: stripeInterval,
      amount: unitAmount / 100
    });

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url
    });

  } catch (error) {
    console.error('❌ Discord bot Stripe checkout error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// File upload endpoint for Discord bots
app.post('/api/upload-discord-bot', upload.single('botFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { serverUuid } = req.body;
    if (!serverUuid) {
      return res.status(400).json({ error: 'Server UUID is required' });
    }

    console.log('📁 Uploading Discord bot file:', {
      filename: req.file.originalname,
      size: req.file.size,
      serverUuid: serverUuid
    });

    // Read the uploaded file
    const fileContent = fs.readFileSync(req.file.path, 'utf8');
    
    // Upload to Pterodactyl server
    await pterodactylRequest('POST', `/servers/${serverUuid}/files/write`, {
      root: '/',
      files: [{
        name: req.file.originalname,
        content: fileContent
      }]
    });

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: 'File uploaded successfully',
      filename: req.file.originalname
    });

  } catch (error) {
    console.error('❌ File upload error:', error.message);
    
    // Clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Discord bot management endpoints
app.post('/api/discord-bot/:serverUuid/start', async (req, res) => {
  try {
    const { serverUuid } = req.params;
    
    await pterodactylRequest('POST', `/servers/${serverUuid}/power`, {
      signal: 'start'
    });
    
    res.json({ success: true, message: 'Discord bot starting' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/discord-bot/:serverUuid/stop', async (req, res) => {
  try {
    const { serverUuid } = req.params;
    
    await pterodactylRequest('POST', `/servers/${serverUuid}/power`, {
      signal: 'stop'
    });
    
    res.json({ success: true, message: 'Discord bot stopping' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/discord-bot/:serverUuid/restart', async (req, res) => {
  try {
    const { serverUuid } = req.params;
    
    await pterodactylRequest('POST', `/servers/${serverUuid}/power`, {
      signal: 'restart'
    });
    
    res.json({ success: true, message: 'Discord bot restarting' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Discord bot status
app.get('/api/discord-bot/:serverUuid/status', async (req, res) => {
  try {
    const { serverUuid } = req.params;
    
    const response = await pterodactylRequest('GET', `/servers/${serverUuid}/resources`);
    const resources = response.data.attributes;
    
    res.json({
      success: true,
      status: resources.current_state,
      cpu: resources.resources.cpu_absolute,
      memory: resources.resources.memory_bytes,
      uptime: resources.resources.uptime
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/discord-health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'discord-bot-hosting',
    stripe: !!stripe,
    memoryStore: sessionCredentialsStore.size,
    nodeId: !!nodeId,
    eggId: !!discordEggId
  });
});

// Start server
const PORT = process.env.DISCORD_PORT || 3002;
app.listen(PORT, () => {
  console.log(`\n🤖 Discord Bot Hosting Service running on port ${PORT}`);
  console.log('📍 Available endpoints:');
  console.log('  GET  /api/discord-session-details/:sessionId');
