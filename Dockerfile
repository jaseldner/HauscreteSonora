# Imagen de la nube para Hauscrete CRM (Node 24, SQLite integrado)
FROM node:24-slim
WORKDIR /app

# Dependencias: solo la librería del servicio de descarga masiva del SAT
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Solo el código, el HTML y los recursos estáticos (la base vive en /data, no en la imagen)
COPY server.mjs db.mjs import-json.mjs backup.mjs sat-descarga.mjs telegram.mjs reporte-admin.mjs modulo-proyectos.html entregas.html entregas-manifest.json logo-hauscrete.png icono-movil-192.png icono-movil-512.png ./

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_FILE=/data/hauscrete.sqlite

EXPOSE 8080
CMD ["node", "server.mjs"]
