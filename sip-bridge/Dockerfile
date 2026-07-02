FROM alpine:latest

# Install Asterisk PBX and Node.js for the EAGI WebSocket bridge
RUN apk add --no-cache asterisk nodejs npm

# Create AGI directory and install ws package for WebSocket connection
WORKDIR /var/lib/asterisk/agi-bin
COPY bridge.package.json ./package.json
RUN npm install --production

# Copy bridge script and make executable
COPY bridge.js ./bridge.js
RUN chmod +x ./bridge.js

# Copy Asterisk configuration files
COPY config/ /etc/asterisk/

# Expose SIP UDP/TCP and RTP ports
EXPOSE 5060/udp 5060/tcp 10000-10050/udp

CMD ["asterisk", "-f", "-vvv"]
