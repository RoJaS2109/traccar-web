FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .
COPY public/ public/
ENV PORT=3007
ENV KML_PATH=/data/kml/general.kml
EXPOSE 3007
CMD ["node", "server.js"]
