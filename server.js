require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const multer  = require('multer');
const ffmpeg  = require('fluent-ffmpeg');
const fs      = require('fs');
const pathMod = require('path');
const os      = require('os');
const { randomUUID } = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
const PORT = process.env.PORT || 3001;

// ── CORS ──
app.use(cors({
  origin: [
    'https://rafanegreiros.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ── Clientes ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Middlewares ──
app.use(express.json({ limit: '10mb' }));

// ── Health check ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Storylab API' });
});

// ── Middleware de autenticação ──
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Erro ao verificar autenticação' });
  }
}

// ── Rota principal: proxy para Anthropic ──
app.post('/api/claude', requireAuth, async (req, res) => {
  const { messages, system, max_tokens, model, tools } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Parâmetro messages inválido' });
  }

  try {
    const params = {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1000,
      messages,
    };
    if (system) params.system = system;
    if (tools && Array.isArray(tools)) params.tools = tools;

    const response = await anthropic.messages.create(params);
    res.json(response);
  } catch (err) {
    console.error('Erro Anthropic:', err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: 'rate_limit', message: err.message });
    }
    res.status(500).json({ error: 'Erro ao chamar Claude', message: err.message });
  }
});

// ── Rota: leitura de URL via Anthropic web_search ──
app.post('/api/fetch', requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: 'URL inválida' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Leia o conteúdo desta URL usando web_search: ${url}

Retorne APENAS este JSON (sem markdown, sem texto extra):
{"title":"título exato da página","content":"transcrição fiel e densa do conteúdo principal em até 1000 palavras — copie os argumentos exatos, não parafraseie nem interprete","tema":"o tema central em até 6 palavras baseado no que a página realmente diz"}`
      }]
    });

    const text = response.content
      .map(b => b.type === 'text' ? b.text : '')
      .join('')
      .replace(/```json|```/g, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]+\}/);
      parsed = match ? JSON.parse(match[0]) : { title: '', content: text, tema: '' };
    }

    res.json({
      url,
      title: parsed.title || '',
      content: parsed.content || '',
      tema: parsed.tema || '',
    });

  } catch (err) {
    console.error('Erro fetch URL:', err.message);
    res.status(500).json({ error: 'Não foi possível ler a URL', message: err.message });
  }
});

// ── Rota: dados do usuário logado ──
app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    created_at: req.user.created_at,
  });
});

// ── Rota: salvar sessão no histórico ──
app.post('/api/history', requireAuth, async (req, res) => {
  const { session_data, tema, step } = req.body;
  const user_id = req.user.id;
  try {
    const { data, error } = await supabase
      .from('carousel_history')
      .insert({ user_id, tema: tema || 'Sem título', step: step || 0, session_data, updated_at: new Date().toISOString() })
      .select('id').single();
    if (error) throw error;
    const { data: allRows } = await supabase
      .from('carousel_history').select('id, created_at')
      .eq('user_id', user_id).order('created_at', { ascending: false });
    if (allRows && allRows.length > 20) {
      const toDelete = allRows.slice(20).map(r => r.id);
      await supabase.from('carousel_history').delete().in('id', toDelete);
    }
    res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('Erro salvar historico:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Rota: atualizar sessão existente ──
app.put('/api/history/:id', requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const { session_data, tema, step } = req.body;
  try {
    const { error } = await supabase
      .from('carousel_history')
      .update({
        session_data,
        tema: tema || 'Sem título',
        step: step || 0,
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('user_id', user_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro update historico:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Rota: listar histórico ──
app.get('/api/history', requireAuth, async (req, res) => {
  const user_id = req.user.id;
  try {
    const { data, error } = await supabase
      .from('carousel_history')
      .select('id, tema, step, updated_at, created_at')
      .eq('user_id', user_id)
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json({ history: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rota: carregar sessão específica ──
app.get('/api/history/:id', requireAuth, async (req, res) => {
  const user_id = req.user.id;
  try {
    const { data, error } = await supabase
      .from('carousel_history')
      .select('*').eq('id', req.params.id).eq('user_id', user_id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rota: deletar sessão ──
app.delete('/api/history/:id', requireAuth, async (req, res) => {
  const user_id = req.user.id;
  try {
    const { error } = await supabase
      .from('carousel_history')
      .delete().eq('id', req.params.id).eq('user_id', user_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers vídeo ──
function bufToTmp(buffer, ext) {
  const p = pathMod.join(os.tmpdir(), randomUUID() + ext);
  fs.writeFileSync(p, buffer);
  return p;
}
function cleanupFiles(...paths) {
  for (const p of paths) { try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
}

// ── POST /video/frame ──
// Extrai um frame PNG do vídeo no instante t (segundos).
// Usado no upload para gerar o thumbnail do card no ZIP.
app.post('/video/frame', upload.single('video'), async (req, res) => {
  const t = parseFloat(req.body?.t ?? '1');
  const ext = pathMod.extname(req.file.originalname || '.mp4') || '.mp4';
  const inputPath  = bufToTmp(req.file.buffer, ext);
  const outputPath = pathMod.join(os.tmpdir(), randomUUID() + '.png');

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(Math.max(0, t))
        .outputOptions(['-frames:v 1', '-f image2'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', (err) => {
          // Se seek passou do fim, tenta no segundo 0
          ffmpeg(inputPath)
            .seekInput(0)
            .outputOptions(['-frames:v 1', '-f image2'])
            .output(outputPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        })
        .run();
    });
    res.setHeader('Content-Type', 'image/png');
    res.send(fs.readFileSync(outputPath));
  } catch (err) {
    console.error('Erro /video/frame:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    cleanupFiles(inputPath, outputPath);
  }
});

// ── POST /video/compose ──
// Recebe o vídeo + overlay PNG com os elementos do card.
// Compõe e retorna um .mp4 1080×1350 pronto para o Instagram.
app.post('/video/compose', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]), async (req, res) => {
  const W       = parseInt(req.body.width   ?? '1080');
  const H       = parseInt(req.body.height  ?? '1350');
  const boxMode = req.body.boxMode === 'true';
  const scale   = parseFloat(req.body.scale   ?? '1');
  const offsetX = parseInt(req.body.offsetX   ?? '0');
  const offsetY = parseInt(req.body.offsetY   ?? '0');

  const videoFile   = req.files['video']?.[0];
  const overlayFile = req.files['overlay']?.[0];
  if (!videoFile || !overlayFile) return res.status(400).json({ error: 'video e overlay são obrigatórios' });

  const videoExt   = pathMod.extname(videoFile.originalname || '.mp4') || '.mp4';
  const inputPath   = bufToTmp(videoFile.buffer,   videoExt);
  const overlayPath = bufToTmp(overlayFile.buffer, '.png');
  const outputPath  = pathMod.join(os.tmpdir(), randomUUID() + '.mp4');

  try {
    let videoFilter;
    if (boxMode) {
      const bx = parseInt(req.body.boxX ?? '0');
      const by = parseInt(req.body.boxY ?? '0');
      const bw = parseInt(req.body.boxW ?? String(W));
      const bh = parseInt(req.body.boxH ?? String(Math.round(H * 0.42)));
      videoFilter = [
        `[0:v]scale=iw*${scale}:-1[scaled]`,
        `[scaled]scale='if(gt(iw/${bw},ih/${bh}),${bh}*iw/ih,${bw})':'if(gt(iw/${bw},ih/${bh}),${bh},${bw}*ih/iw)'[fitted]`,
        `[fitted]crop=${bw}:${bh}:'(iw-${bw})/2+${offsetX}':'(ih-${bh})/2+${offsetY}'[cropped]`,
        `color=black@0:${W}x${H}[base]`,
        `[base][cropped]overlay=${bx}:${by}[bgcomp]`,
      ].join(';');
    } else {
      videoFilter = [
        `[0:v]scale='if(gt(iw/${W},ih/${H}),${W},${H}*iw/ih)*${scale}':'if(gt(iw/${W},ih/${H}),${W}*ih/iw,${H})*${scale}'[scaled]`,
        `[scaled]crop=${W}:${H}:'(iw-${W})/2+${offsetX}':'(ih-${H})/2+${offsetY}'[bgcomp]`,
      ].join(';');
    }
    const fullFilter = videoFilter + `;[bgcomp][1:v]overlay=0:0[out]`;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputPath)
        .input(overlayPath)
        .complexFilter(fullFilter, 'out')
        .outputOptions(['-c:v libx264', '-preset fast', '-crf 22', '-pix_fmt yuv420p', '-movflags +faststart', '-an'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="card.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('close', () => cleanupFiles(inputPath, overlayPath, outputPath));

  } catch (err) {
    cleanupFiles(inputPath, overlayPath, outputPath);
    console.error('Erro /video/compose:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Inicia servidor ──
app.listen(PORT, () => {
  console.log(`✅ Storylab API rodando na porta ${PORT}`);
});
