const path = require('node:path');
const { createRequire } = require('node:module');

const cliRequire = createRequire(require.resolve('@expo/cli/package.json', {
  paths: [path.dirname(require.resolve('expo/package.json'))],
}));
const { z } = cliRequire('zod');
const { PluginSchema, DevToolsPluginOutputSchema } = cliRequire('./build/src/start/server/DevToolsPlugin.schema');
const { createMCPDevToolsExtensionSchema } = cliRequire('./build/src/start/server/createMCPDevToolsExtensionSchema');
const { DevToolsPluginCliExtensionResults } = cliRequire('./build/src/start/server/DevToolsPluginCliExtensionResults');

describe('Expo CLI compatibility with the upstream Zod release', () => {
  const plugin = {
    packageName: 'fixture',
    packageRoot: '/tmp/fixture',
    cliExtensions: {
      description: 'Fixture extension',
      entryPoint: './tool.js',
      commands: [{
        name: 'check',
        title: 'Check',
        environments: ['cli', 'mcp'],
        parameters: [
          { name: 'count', type: 'number' },
          { name: 'accepted', type: 'confirm' },
          { name: 'label', type: 'text' },
        ],
      }],
    },
  };

  test('rejects oversized arrays before parsing any elements', () => {
    let visits = 0;
    const schema = z.array(z.string().refine(() => { visits++; return false; })).max(2);
    const result = schema.safeParse(Array(10_000).fill('invalid'));
    expect(result.success).toBe(false);
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0].code).toBe('too_big');
    expect(visits).toBe(0);
  });

  test('validates plugin metadata, strips unknown keys, and preserves readonly environments', () => {
    const parsed = PluginSchema.parse({ ...plugin, unknown: 'discard' });
    expect(parsed).toEqual(plugin);
    expect(Object.isFrozen(parsed.cliExtensions.commands[0].environments)).toBe(true);
    expect(PluginSchema.safeParse({ ...plugin, packageName: '' }).success).toBe(false);
    expect(PluginSchema.safeParse({
      ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] },
    }).success).toBe(false);
    expect(PluginSchema.safeParse({
      ...plugin,
      cliExtensions: { ...plugin.cliExtensions, commands: [{ ...plugin.cliExtensions.commands[0], environments: ['invalid'] }] },
    }).success).toBe(false);
  });

  test('parses text/audio/image output and returns usable validation errors', () => {
    const output = [
      { type: 'text', text: 'ok', level: 'info' },
      { type: 'audio', url: 'https://example.com/audio' },
      { type: 'image', url: 'https://example.com/image', text: 'image' },
    ];
    expect(DevToolsPluginOutputSchema.parse(output)).toEqual(output);
    const results = new DevToolsPluginCliExtensionResults();
    expect(results.parseOutputText(JSON.stringify(output))).toEqual(output);
    expect(results.parseOutputText('[{"type":"image","url":"invalid"}]')[0])
      .toMatchObject({ type: 'text', level: 'error', text: expect.stringContaining('Invalid JSON') });
    expect(results.parseOutputText('plain output')[0]).toMatchObject({ text: 'plain output' });
  });

  test('MCP schemas validate command parameters and convert to strict JSON Schema', () => {
    const schema = createMCPDevToolsExtensionSchema(plugin);
    expect(schema.parse({ command: 'check', count: 2, accepted: true, label: 'ok' }))
      .toEqual({ command: 'check', count: 2, accepted: true, label: 'ok' });
    expect(schema.safeParse({ command: 'check' }).success).toBe(true);
    for (const invalid of [{}, { command: 'unknown' }, { command: 'check', extra: 1 }, { command: 'check', count: '2' }]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
    const json = z.toJSONSchema(schema);
    expect(json).toMatchObject({
      type: 'object', additionalProperties: false, required: ['command'],
      properties: {
        command: { enum: ['check'] }, count: { type: 'number' },
        accepted: { type: 'boolean' }, label: { type: 'string' },
      },
    });
    expect(() => createMCPDevToolsExtensionSchema({ packageName: 'empty' })).toThrow(/no commands/);
  });
});
