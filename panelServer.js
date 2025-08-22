const express = require('express');
const axios = require('axios');
require('dotenv').config();

const validateEnvVars = () => {
  const requiredVars = [
    'PTERODACTYL_API_URL',
    'PTERODACTYL_API_KEY'
  ];
  
  const missingRequired = requiredVars.filter(varName => !process.env[varName]);
  if (missingRequired.length > 0) {
    console.error('❌ Missing required environment variables:', missingRequired.join(', '));
    process.exit(1);
  }
};

validateEnvVars();

const PTERODACTYL_BASE = process.env.PTERODACTYL_API_URL;
const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;

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
    console.error(`❌ ${method} ${endpoint} - Error:`, {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
};

const serverPlans = {
  'starter': { memory: 2048, disk: 10240, cpu: 100, swap: 0, io: 500, databases: 1, backups: 1 },
  'standard': { memory: 4096, disk: 20480, cpu: 200, swap: 0, io: 500, databases: 2, backups: 2 },
  'premium': { memory: 8192, disk: 40960, cpu: 300, swap: 0, io: 500, databases: 3, backups: 3 },
  'ultimate': { memory: 16384, disk: 81920, cpu: 400, swap: 0, io: 500, databases: 5, backups: 5 }
};

const router = express.Router();

router.use(express.json());

const getServerDetails = async (serverId) => {
  try {
    const response = await pterodactylRequest('GET', `/api/application/servers/${serverId}`);
    return response.data;
  } catch (error) {
    console.error(`Failed to get server details for ID: ${serverId}`, error);
    throw error;
  }
};

const updateServerResources = async (serverId, resources) => {
  try {
    const updatePayload = {
      allocation: resources.allocation || null,
      memory: resources.memory || null,
      swap: resources.swap || null,
      disk: resources.disk || null,
      io: resources.io || null,
      cpu: resources.cpu || null,
      threads: resources.threads || null,
      feature_limits: {
        databases: resources.databases || null,
        backups: resources.backups || null
      }
    };

    Object.keys(updatePayload).forEach(key => {
      if (updatePayload[key] === null) delete updatePayload[key];
    });

    if (updatePayload.feature_limits) {
      Object.keys(updatePayload.feature_limits).forEach(key => {
        if (updatePayload.feature_limits[key] === null) delete updatePayload.feature_limits[key];
      });
      
      if (Object.keys(updatePayload.feature_limits).length === 0) {
        delete updatePayload.feature_limits;
      }
    }

    const response = await pterodactylRequest(
      'PATCH', 
      `/api/application/servers/${serverId}/build`,
      updatePayload
    );

    return response.data;
  } catch (error) {
    console.error(`Failed to update server resources for ID: ${serverId}`, error);
    throw error;
  }
};


const upgradeServerPlan = async (serverId, newPlanId) => {
  try {
    const newPlan = serverPlans[newPlanId];
    if (!newPlan) {
      throw new Error(`Invalid plan ID: ${newPlanId}`);
    }

    return await updateServerResources(serverId, newPlan);
  } catch (error) {
    console.error(`Failed to upgrade server plan for ID: ${serverId}`, error);
    throw error;
  }
};

const customServerUpdate = async (serverId, resources) => {
  try {
    const validResources = {};
    
    if (resources.memory && Number.isInteger(resources.memory)) {
      validResources.memory = resources.memory;
    }
    
    if (resources.disk && Number.isInteger(resources.disk)) {
      validResources.disk = resources.disk;
    }
    
    if (resources.cpu && Number.isInteger(resources.cpu)) {
      validResources.cpu = resources.cpu;
    }
    
    if (resources.databases && Number.isInteger(resources.databases)) {
      validResources.databases = resources.databases;
    }
    
    if (resources.backups && Number.isInteger(resources.backups)) {
      validResources.backups = resources.backups;
    }
    return await updateServerResources(serverId, validResources);
  } catch (error) {
    console.error(`Failed to update server resources for ID: ${serverId}`, error);
    throw error;
  }
};

router.get('/servers/:serverId', async (req, res) => {
  try {
    const { serverId } = req.params;
    
    if (!serverId) {
      return res.status(400).json({ error: 'Server ID is required' });
    }

    const serverDetails = await getServerDetails(serverId);
    res.json({
      success: true,
      data: serverDetails
    });
  } catch (error) {
    console.error('Error getting server details:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.errors || error.message
    });
  }
});

router.post('/servers/:serverId/upgrade', async (req, res) => {
  try {
    const { serverId } = req.params;
    const { planId } = req.body;
    
    if (!serverId) {
      return res.status(400).json({ error: 'Server ID is required' });
    }
    
    if (!planId || !serverPlans[planId]) {
      return res.status(400).json({ 
        error: 'Valid plan ID is required',
        availablePlans: Object.keys(serverPlans)
      });
    }

    const updatedServer = await upgradeServerPlan(serverId, planId);
    res.json({
      success: true,
      message: `Server upgraded to ${planId} plan successfully`,
      data: updatedServer
    });
  } catch (error) {
    console.error('Error upgrading server plan:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.errors || error.message
    });
  }
});

router.post('/servers/:serverId/resources', async (req, res) => {
  try {
    const { serverId } = req.params;
    const resources = req.body;
    
    if (!serverId) {
      return res.status(400).json({ error: 'Server ID is required' });
    }
    
    if (!resources || Object.keys(resources).length === 0) {
      return res.status(400).json({ error: 'Resource updates are required' });
    }

    const updatedServer = await customServerUpdate(serverId, resources);
    res.json({
      success: true,
      message: 'Server resources updated successfully',
      data: updatedServer
    });
  } catch (error) {
    console.error('Error updating server resources:', error);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.errors || error.message
    });
  }
});
router.get('/plans', (req, res) => {
  res.json({
    success: true,
    data: serverPlans
  });
});

module.exports = router;
