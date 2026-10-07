// Minimal server-side WebSocket (RFC 6455) for the local Waybill server:
// unfragmented text frames, ping/pong and close. Enough for small JSON
// messages between the server and each browser profile's extension.
import { createHash } from 'node:crypto';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 4_000_000;
const OPCODE = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa };

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  return Buffer.concat([header, payload]);
}

// Returns { final, opcode, payload, size } or null when the frame is incomplete.
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const final = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (length > MAX_MESSAGE_BYTES) return { tooLarge: true };
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { final, opcode, payload, size: offset + length };
}

// Completes the upgrade handshake on `socket` and returns a connection:
// { send(object), close() }. `onMessage(object)` receives parsed JSON messages;
// `onClose()` runs once when the connection ends for any reason.
export function acceptWebSocket(request, socket, { onMessage, onClose }) {
  const key = request.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));

  let buffer = Buffer.alloc(0);
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
    onClose();
  };
  const closeWith = (code) => {
    if (closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    socket.write(encodeFrame(OPCODE.close, payload));
    finish();
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let frame = decodeFrame(buffer); frame; frame = decodeFrame(buffer)) {
      if (frame.tooLarge) return closeWith(1009);
      buffer = buffer.subarray(frame.size);
      if (frame.opcode === OPCODE.close) return closeWith(1000);
      if (frame.opcode === OPCODE.ping) { socket.write(encodeFrame(OPCODE.pong, frame.payload)); continue; }
      if (frame.opcode === OPCODE.pong) continue;
      if (frame.opcode !== OPCODE.text || !frame.final) return closeWith(1003);
      let message;
      try { message = JSON.parse(frame.payload.toString('utf8')); } catch { return closeWith(1007); }
      onMessage(message);
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);

  return {
    send: (object) => { if (!closed) socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(object)))); },
    close: () => closeWith(1000),
  };
}
