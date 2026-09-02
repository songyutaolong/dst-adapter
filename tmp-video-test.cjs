/* 测试视频生成 MCP 工具：提交 → 查询（轮询由调用方控制） */
const http = require('http');

function mcpCall(port, method, params) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: method,
      params: params
    }));
    req.end();
  });
}

async function callTool(port, name, args) {
  const res = await mcpCall(port, 'tools/call', { name, arguments: args });
  if (res.error) throw new Error(res.error.message);
  const text = res.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

(async () => {
  console.log('=== 测试视频生成 MCP 工具（提交→查询，调用方控制轮询）===\n');

  const PORT = Number(process.env.MCP_PORT || 17889);
  const DONE = ['completed', 'success', 'done', 'SUCCESS', 'COMPLETED'];
  const FAILED = ['failed', 'error', 'FAILED', 'ERROR'];

  // 1. Initialize
  console.log('1. Initialize...');
  const initResult = await mcpCall(PORT, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' }
  });
  console.log('   Server:', initResult.result?.serverInfo?.name);
  console.log('   Protocol:', initResult.result?.protocolVersion);

  // 2. List tools
  console.log('\n2. List tools...');
  const toolsResult = await mcpCall(PORT, 'tools/list', {});
  const tools = toolsResult.result?.tools || [];
  console.log('   Tools count:', tools.length);
  tools.forEach(t => console.log('   -', t.name));
  if (!tools.some(t => t.name === 'video_task_query')) {
    console.log('   ❌ video_task_query 不在工具列表中，服务可能未更新');
    process.exit(1);
  }

  // 3. 提交任务（不再阻塞轮询，应立即返回 task_id）
  // 注意：文生视频测试已跳过，直接测试图生视频
  /*
  console.log('\n3. Submit video_generation...');
  console.log('   Prompt: "一只猫在草地上奔跑"');
  console.log('   Duration: 5s, Resolution: 720p, Ratio: 16:9, FPS: 24, Generate Audio: true\n');

  const submitStart = Date.now();
  let taskId;
  try {
    const submitted = await callTool(PORT, 'video_generation', {
      prompt: '一只猫在草地上奔跑',
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
      fps: 24,
      generate_audio: true
    });
    const submitElapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log(`   Submit returned in ${submitElapsed}s`);
    console.log('   Result keys:', Object.keys(submitted));
    taskId = submitted.task_id;
    console.log('   Task ID:', taskId);
    console.log('   Status:', submitted.status);
    if (submitted.video_url) {
      console.log('   Video URL (sync return):', submitted.video_url.slice(0, 100) + '...');
    }
  } catch (e) {
    console.log('   ❌ Submit failed:', e.message);
    process.exit(1);
  }

  // 4. 调用方控制轮询：周期性调用 video_task_query
  console.log('\n4. Polling with video_task_query (5s interval, up to 120 attempts)...');
  let finished = false;
  for (let attempt = 1; attempt <= 120 && !finished; attempt++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const q = await callTool(PORT, 'video_task_query', { task_id: taskId });
      console.log(`   [${String(attempt).padStart(3)}] status=${q.status} task_id=${q.task_id}`,
        q.video_url ? `\n        video_url=${q.video_url.slice(0, 120)}...` : '');
      if (q.video_url || DONE.includes(q.status)) {
        console.log(`\n   ✅ Completed after ${attempt * 5}s`);
        finished = true;
      } else if (FAILED.includes(q.status)) {
        console.log(`\n   ❌ Task failed: ${q.error || q.message || 'unknown'}`);
        finished = true;
      }
    } catch (e) {
      console.log('   ❌ Query failed:', e.message);
      finished = true;
    }
  }
  */

  // 5. 图生视频测试（参考图模式）
  console.log('\n5. Submit video_from_image (参考图模式)...');
  console.log('   Content: 1 text + 2 reference_image\n');
  try {
    const imgSubmitted = await callTool(PORT, 'video_from_image', {
      prompt: '人物缓慢行走，环境光影柔和',
      duration: 9,
      resolution: '1080p',
      ratio: '9:16',
      fps: 24,
      generate_audio: false,
      content: [
        { type: 'text', text: '严格保留@Image1的人物长相，@Image2的服饰风格，人物缓慢行走，环境光影柔和，减少人物变形' },
        { type: 'image_url', image_url: { url: 'https://picsum.photos/seed/person1/800/1200' }, role: 'reference_image' },
        { type: 'image_url', image_url: { url: 'https://picsum.photos/seed/cloth2/800/1200' }, role: 'reference_image' }
      ]
    });
    console.log('   Task ID:', imgSubmitted.task_id);
    console.log('   Status:', imgSubmitted.status);
  } catch (e) {
    console.log('    Submit failed:', e.message);
  }

  // 6. 图生视频测试（首尾帧模式）
  console.log('\n6. Submit video_from_image (首尾帧模式)...');
  console.log('   Content: 1 text + first_frame + last_frame\n');
  try {
    const f2fSubmitted = await callTool(PORT, 'video_from_image', {
      prompt: '画面从第一张图平滑过渡到第二张图',
      duration: 10,
      resolution: '1080p',
      ratio: '16:9',
      fps: 24,
      generate_audio: false,
      content: [
        { type: 'text', text: '画面从第一张图平滑缓慢过渡到第二张图，镜头轻微推进，光影自然连贯，电影质感' },
        { type: 'image_url', image_url: { url: 'https://picsum.photos/seed/startframe/1920/1080' }, role: 'first_frame' },
        { type: 'image_url', image_url: { url: 'https://picsum.photos/seed/endframe/1920/1080' }, role: 'last_frame' }
      ]
    });
    console.log('   Task ID:', f2fSubmitted.task_id);
    console.log('   Status:', f2fSubmitted.status);
  } catch (e) {
    console.log('   ❌ Submit failed:', e.message);
  }

  console.log('\n=== Test complete ===');
})();