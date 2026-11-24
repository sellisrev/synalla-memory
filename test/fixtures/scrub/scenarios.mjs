// Random scenarios for scrub.ts. Data for the tests: don't change this file.
export function rng(seed) {
  let s = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  s = Math.imul(s ^ (s >>> 13), 0xc2b2ae35) >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 4; i++) next();
  return next;
}
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', al = 'abcdefghijklmnopqrstuvwxyz', D = '0123456789';
const B32 = '02345678' + '9acdefghjklmnpqrstuvwxyz';
export function makeScenario(seed) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const str = (chars, n) => { let o = ''; for (let i = 0; i < n; i++) o += chars[Math.floor(r() * chars.length)]; return o; };
  const n = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const mix = AL + al + D;
  const secrets = [
    () => `-----BEGIN ${pick(['', 'RSA ', 'OPENSSH ', 'EC ', 'PGP '])}PRIVATE KEY${pick(['', ' BLOCK'])}-----\n${str(mix + '+/', 64)}\n${str(mix, n(4, 40))}=${r() < 0.25 ? '\n(output truncated)' : `\n-----END ${pick(['', 'RSA ', 'OPENSSH ', 'PGP '])}PRIVATE KEY${pick(['', ' BLOCK'])}-----`}`,
    () => { const u = str(al, n(0, 8)); return `${pick(['postgres', 'mysql', 'https', 'redis', 'amqp'])}://${u}:${r() < 0.2 && u ? u : str(mix + '!$%^*', n(1, 20))}@${str(al, n(3, 8))}.${pick(['local', 'com', 'io'])}${pick(['', ':5432', '/db'])}`; },
    () => `eyJ${str(mix + '_-', n(8, 30))}.eyJ${str(mix + '_-', n(8, 60))}.${str(mix + '_-', n(8, 43))}`,
    () => `${pick(['AKIA', 'ASIA'])}${str(AL + D, 16)}`,
    () => pick([`gh${pick(['p', 'o', 'u', 's', 'r'])}_${str(mix, n(36, 40))}`, `github_pat_${str(mix + '_', n(22, 82))}`]),
    () => `sk-ant-${pick(['api03-', 'admin01-', ''])}${str(mix + '_-', n(20, 90))}`,
    () => `sk-${pick(['proj-', ''])}${str(mix + '_-', n(20, 60))}`,
    () => `${pick(['sk', 'rk'])}_${pick(['live', 'test'])}_${str(mix, n(16, 40))}`,
    () => `xox${pick(['a', 'b', 'p', 'o', 's', 'r'])}-${str(D + mix + '-', n(10, 50))}`,
    () => `AIza${str(mix + '_-', 35)}`,
    () => `${pick(['hf_', 'glpat-', 'whsec_', 'npm_', 'gsk_', 'pypi-'])}${str(mix + '_-', n(20, 50))}`,
    () => `nsec1${str(B32, 58)}`,
    () => `${pick(['Authorization', 'authorization'])}${pick([': ', '=', ':'])}${pick(['Bearer', 'bearer', 'Basic', 'Token'])} ${str(mix + '._~+/=-', n(8, 60))}`,
    () => `${pick(['Bearer', 'bearer', 'BEARER'])} ${str(mix + '._~+/=-', n(14, 40))}`,
    () => {
      const k = pick(['password', 'PASSWORD', 'db_password', 'passphrase', 'Secret', 'token', 'GITHUB_TOKEN', 'api_key', 'apiKey', 'OPENROUTER_API_KEY',
        'access-key', 'SECRET_KEY', 'private_key', '"accessToken"', '"SecretAccessKey"', 'refresh_token', 'client_secret', 'authToken']);
      const q = pick(['"', "'", '', '', '']), v = r() < 0.15 ? k.replace(/"/g, '') : str(mix + '!.$-/', n(4, 30));
      return `${k}${pick(['=', ': ', ' = ', ':'])}${q}${v}${q}`;
    },
    () => str(mix, n(32, 64)),
  ];
  const harmless = [
    () => `commit ${str('0123456789abcdef', 40)}`,
    () => `${str('0123456789abcdef', 8)}-${str('0123456789abcdef', 4)}-4${str('0123456789abcdef', 3)}-a${str('0123456789abcdef', 3)}-${str('0123456789abcdef', 12)}`,
    () => `src/${str(al, n(3, 10))}/${pick(['My', 'Your', 'Big'])}Component${n(1, 9)}/index.tsx`,
    () => `const ${str(al, n(5, 10))}${pick(['Handler', 'Manager', 'Factory'])}${n(1, 99)}LongerName = ${n(0, 99)};`,
    () => pick(['secret = true', 'token: 5', 'password reset done', 'the api key is in the vault', 'PASSWORD_FILE=/etc/pw', 'my_secret_sauce = tomato',
      'token: string', 'password: string;', 'apiKey: apiKey,', '{ password: hashedPassword }', 'secret: config.secret', 'token = getToken()',
      'password=os.environ["DB_PASSWORD"]', 'api_key=${API_KEY}', 'PWD=/home/dev/project', 'token: expired', 'input_token: 123456',
      'Token management is hard', 'https://host:443?x=1&email=a@b.com', 'sk-learn-compatible-estimator-wrapper']),
    () => `--model=${pick(['Qwen3-Coder-30B-A3B-Instruct-Q4_K_M', 'Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf', 'gemma-4-E4B-it-Q8_0', 'Llama-3.3-70B-Instruct-IQ4_XS'])}`,
    () => `${pick(['sha512-', 'sha256-', 'ssh-ed25519 AAAA'])}${str(mix + '+/', n(40, 80))}${pick(['', '=='])}`,
    () => { const v = pick(secrets.slice(2, 12))(); return r() < 0.5 ? v.slice(0, -1) : 'x' + v; },
    () => `${pick(['password', 'token', 'api_key'])}=${pick(['"', ''])}${str(mix + '9', 5)}`,
    () => `https://${str(al, n(3, 10))}.com/${str(al, n(2, 8))}?q=${str(al + D, n(1, 12))}`,
    () => pick(['Meeting at 10:30 tomorrow.', 'Merci pour ton message !', 'Größe: 42', 'ok 👍 done', '']),
    () => str(mix, n(8, 31)),
  ];
  const steps = [];
  const count = n(6, 12);
  for (let i = 0; i < count; i++) {
    if (r() < 0.06) { steps.push({ op: pick(['scrub', 'marker']), args: [pick([undefined, null, 1, [], {}, true, 'jwt ', 'JWT'])] }); continue; }
    if (r() < 0.15) { steps.push({ op: 'marker', args: [r() < 0.8 ? pick(['private-key', 'jwt', 'assignment', 'high-entropy', 'auth-header', 'prefixed-token', 'bearer']) : pick(['nope', 'toString'])] }); continue; }
    const parts = [];
    const k = n(1, 6);
    for (let j = 0; j < k; j++) parts.push(r() < 0.55 ? pick(secrets)() : pick(harmless)());
    steps.push({ op: 'scrub', args: [parts.join(pick([' ', '\n', ' and ', ', ', '\t', '']))] });
  }
  return steps;
}
export function runScenario(impl, steps) {
  return steps.map(step => {
    const before = JSON.stringify(step.args);
    let result;
    try { result = { value: JSON.parse(JSON.stringify(impl[step.op](...step.args))) }; } catch (e) { result = { throws: e && e.name ? e.name : 'thrown' }; }
    if (JSON.stringify(step.args) !== before) result.mutatedInput = true;
    return result;
  });
}
export const GOLDEN_SEEDS = [21, 22, 23, 24, 25, 26, 27, 28];
