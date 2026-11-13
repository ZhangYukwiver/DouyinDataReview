/* 知识库的本机语义向量，算法同轻阅网页端：bge-small-zh-v1.5 fp32、CLS 向量、510 token 窗口每 430 步重叠，平均后归一化。
 * 模型文件由页面从采集器取来交给这里；分词和推理都在这个 Worker 里，不出本机。运行库由 scripts/stage-knowledge-runtime.mjs 放进 vendor/。 */
let library, tokenizer, model, queue = Promise.resolve();
const DIMENSION = 512, QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

async function init(files) {
  if (model) return;
  library ||= await import('./vendor/transformers.min.js');
  const { env, AutoTokenizer, AutoModel } = library;
  env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = '/knowledge-model/';
  env.useBrowserCache = false; env.useCustomCache = true;
  // transformers.js 取文件先问缓存：直接用页面交来的那几份
  env.customCache = {
    match: async key => { const name = Object.keys(files).find(file => String(key).endsWith(`/${file}`)); return name ? new Response(files[name]) : undefined; },
    put: async () => {}
  };
  env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained('bge-small-zh-v1.5', { local_files_only: true }),
    AutoModel.from_pretrained('bge-small-zh-v1.5', { local_files_only: true, dtype: 'fp32', device: 'wasm' })
  ]);
}

async function embed(text, query) {
  // 不截断地分词，再用和模型同宽的重叠窗口覆盖每个 token
  const ids = tokenizer((query ? QUERY_PREFIX : '') + text, { add_special_tokens: false, truncation: false, return_tensor: false }).input_ids;
  const special = tokenizer('', { return_tensor: false }).input_ids;
  const result = new Float32Array(DIMENSION);
  for (let start = 0; start < Math.max(1, ids.length); start += 430) {
    const end = Math.min(ids.length, start + 510), input = [special[0], ...ids.slice(start, end), special.at(-1)];
    const dims = [1, input.length];
    const outputs = await model({
      input_ids: new library.Tensor('int64', BigInt64Array.from(input, BigInt), dims),
      attention_mask: new library.Tensor('int64', new BigInt64Array(input.length).fill(1n), dims),
      token_type_ids: new library.Tensor('int64', new BigInt64Array(input.length), dims)
    });
    const hidden = outputs.last_hidden_state;
    if (!hidden || hidden.dims.at(-1) !== DIMENSION) throw new Error('模型输出维度不匹配');
    let norm = 0;
    for (let i = 0; i < DIMENSION; i++) norm += hidden.data[i] ** 2;
    norm = Math.sqrt(norm);
    if (!Number.isFinite(norm) || !norm) throw new Error('模型返回了无效向量');
    for (let i = 0; i < DIMENSION; i++) result[i] += hidden.data[i] / norm;
    for (const tensor of Object.values(outputs)) tensor.dispose?.();
    if (end === ids.length) break;
  }
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm)) throw new Error('无法归一化语义向量');
  for (let i = 0; i < result.length; i++) result[i] /= norm;
  return result;
}

self.onmessage = event => {
  const message = event.data;
  queue = queue.catch(() => {}).then(async () => {
    try {
      if (message.type === 'init') { await init(message.files); self.postMessage({ id: message.id, result: true }); return; }
      if (!model) throw new Error('本地模型还没加载');
      const vector = await embed(String(message.text || ''), Boolean(message.query));
      self.postMessage({ id: message.id, result: vector }, [vector.buffer]);
    } catch (error) { self.postMessage({ id: message.id, error: error.message || '本地模型运行失败' }); }
  });
};
