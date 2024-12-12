const http = require("http");
const express = require("express");
const Docker = require("dockerode");
const httpProxy = require("http-proxy");

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const proxy = httpProxy.createProxy({});
const db = new Map();

// Event listener for Docker container start events
docker.getEvents((err, stream) => {
   if (err) {
    console.error(`Error in getting Docker events:`, err);
    return;
   }

   stream.on("data", async (chunk) => {
    try {
        if (!chunk) return;
        const event = JSON.parse(chunk.toString());

        if (event.Type === "container" && event.Action === "start") {
            const container = docker.getContainer(event.id);
            const containerInfo = await container.inspect();

            const containerName = containerInfo.Name.substring(1);
            const ipAddress = containerInfo.NetworkSettings.IPAddress;

            const exposedPorts = Object.keys(containerInfo.Config.ExposedPorts || {});
            let defaultPort = null;

            if (exposedPorts && exposedPorts.length > 0) {
                const [port, type] = exposedPorts[0].split("/");
                if (type === "tcp") {
                    defaultPort = port;
                }
            }

            if (defaultPort) {
                console.log(`Registering ${containerName}.localhost ---> http://${ipAddress}:${defaultPort}`);
                db.set(containerName, { containerName, ipAddress, defaultPort });
            }
        }
    } catch (error) {
        console.error('Error processing Docker event:', error);
    }
   });
});

// Reverse Proxy Application
const reverseProxyApp = express();

reverseProxyApp.use((req, res) => {
    const hostname = req.hostname;
    const subdomain = hostname.split('.')[0];

    if (!db.has(subdomain)) return res.status(404).end('Container not found');

    const { ipAddress, defaultPort } = db.get(subdomain);

    const target = `http://${ipAddress}:${defaultPort}`;

    console.log(`Forwarding ${hostname} -> ${target}`);

    proxy.web(req, res, { target, changeOrigin: true, ws: true });
});

const reverseProxy = http.createServer(reverseProxyApp);

// WebSocket upgrade handler
reverseProxy.on('upgrade', (req, socket, head) => {
    const hostname = req.headers.host.split('.')[0];

    if (!db.has(hostname)) {
        socket.destroy();
        return;
    }

    const { ipAddress, defaultPort } = db.get(hostname);
    const target = `http://${ipAddress}:${defaultPort}`;

    proxy.ws(req, socket, head, {
        target: target,
        ws: true,
    });
});

// Management API
const managementAPI = express();
managementAPI.use(express.json());

managementAPI.post("/containers", async (req, res) => {
    try {
        const { image, tag = "latest" } = req.body;

        let imageAlreadyExists = false;
        const images = await docker.listImages();
         
        for (const systemImage of images) {
            for (const systemTag of systemImage.RepoTags || []) {
                if (systemTag === `${image}:${tag}`) {
                    imageAlreadyExists = true;
                    break;
                }
            }
            if (imageAlreadyExists) break;
        }

        if (!imageAlreadyExists) {
            console.log(`Pulling image ${image}:${tag}`);
            await docker.pull(`${image}:${tag}`);
        }

        const container = await docker.createContainer({
            Image: `${image}:${tag}`,
            Tty: false,
            HostConfig: {
                AutoRemove: true,
            },
        });
        
        await container.start();
        
        return res.json({
            status: 'success',
            container: `${(await container.inspect()).Name}.localhost`,
        });
    } catch (error) {
        console.error('Error creating container:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Start servers
const managementAPIServer = managementAPI.listen(8080, () => 
    console.log(`Management API running on port 8080`)
);

reverseProxy.listen(80, () => {
    console.log(`Reverse Proxy is running on port 80`);
});
