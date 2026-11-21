// Read the public renderer's own protobuf descriptors so sample stream data uses
// the same schema as that renderer. No upstream JavaScript is modified.
function readWire(data) {
  let offset = 0;
  const fields = new Map();
  const varint = () => {
    let value = 0, shift = 0, byte;
    do { byte = data[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  };
  while (offset < data.length) {
    const tag = varint(), number = Math.floor(tag / 8), type = tag & 7;
    let value;
    if (type === 0) value = varint();
    else if ([1, 2, 5].includes(type)) {
      const length = type === 2 ? varint() : type === 1 ? 8 : 4;
      value = data.subarray(offset, offset + length); offset += length;
    } else throw new Error(`Unsupported descriptor wire type ${type}`);
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}

function readSchemas(javascript) {
  const messages = new Map(), enums = new Map(), methods = new Map();
  const text = (fields, number) => fields.get(number)?.[0]?.toString() || '';
  function addEnum(data, prefix) {
    const fields = readWire(data);
    enums.set(`${prefix}.${text(fields, 1)}`, Object.fromEntries((fields.get(2) || []).map(item => {
      const value = readWire(item); return [text(value, 1), value.get(2)[0]];
    })));
  }
  function addMessage(data, prefix) {
    const fields = readWire(data), name = `${prefix}.${text(fields, 1)}`;
    messages.set(name, (fields.get(2) || []).map(item => {
      const field = readWire(item), protoName = text(field, 1);
      return { name: protoName, jsonName: text(field, 10) || protoName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
        number: field.get(3)[0], repeated: field.get(4)[0] === 3, type: field.get(5)[0], typeName: text(field, 6) };
    }));
    for (const item of fields.get(3) || []) addMessage(item, name);
    for (const item of fields.get(4) || []) addEnum(item, name);
  }
  for (const match of javascript.matchAll(/od\("([A-Za-z0-9+/=]+)"/g)) {
    const file = readWire(Buffer.from(match[1], 'base64')), prefix = `.${text(file, 2)}`;
    for (const item of file.get(4) || []) addMessage(item, prefix);
    for (const item of file.get(5) || []) addEnum(item, prefix);
    for (const item of file.get(6) || []) {
      const service = readWire(item);
      for (const item of service.get(2) || []) {
        const method = readWire(item);
        methods.set(`/${prefix.slice(1)}.${text(service, 1)}/${text(method, 1)}`, { output: text(method, 3) });
      }
    }
  }
  return { messages, enums, methods };
}

function varint(value) {
  let number = BigInt(value);
  if (number < 0) number = BigInt.asUintN(64, number);
  const bytes = [];
  do { const byte = Number(number & 127n); number >>= 7n; bytes.push(byte | (number ? 128 : 0)); } while (number);
  return Buffer.from(bytes);
}

function encodeMessage(schemas, name, object) {
  if (name === '.google.protobuf.Timestamp' && typeof object === 'string') {
    const milliseconds = Date.parse(object);
    object = { seconds: Math.floor(milliseconds / 1000), nanos: milliseconds % 1000 * 1e6 };
  }
  const fields = schemas.messages.get(name);
  if (!fields) throw new Error(`Missing upstream message descriptor: ${name}`);
  const chunks = [];
  for (const field of fields) {
    const value = object[field.jsonName] ?? object[field.name];
    if (value == null) continue;
    const values = field.repeated ? Array.isArray(value) ? value : Object.entries(value).map(([key, value]) => ({ key, value })) : [value];
    for (let item of values) {
      let type, payload;
      if (field.type === 11) { type = 2; payload = encodeMessage(schemas, field.typeName, item); }
      else if (field.type === 9 || field.type === 12) {
        type = 2; payload = Buffer.from(String(item), field.type === 12 ? 'base64' : 'utf8');
      } else if (field.type === 1 || field.type === 2) {
        type = field.type === 1 ? 1 : 5; payload = Buffer.alloc(type === 1 ? 8 : 4);
        type === 1 ? payload.writeDoubleLE(item) : payload.writeFloatLE(item);
      } else {
        type = 0;
        if (field.type === 14 && typeof item === 'string') item = schemas.enums.get(field.typeName)?.[item] ?? 0;
        payload = varint(field.type === 8 ? Number(Boolean(item)) : item);
      }
      chunks.push(varint(field.number * 8 + type));
      if (type === 2) chunks.push(varint(payload.length));
      chunks.push(payload);
    }
  }
  return Buffer.concat(chunks);
}

function encodeStreamMessage(schemas, method, object) {
  const descriptor = schemas.methods.get(method);
  if (!descriptor) throw new Error(`Unknown upstream sample RPC: ${method}`);
  const payload = encodeMessage(schemas, descriptor.output, object), header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

module.exports = { readSchemas, encodeStreamMessage };
