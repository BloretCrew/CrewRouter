#!/usr/bin/env node

/**
 * Fusion 功能测试脚本
 *
 * 用法: node scripts/test-fusion.js
 *
 * 前置条件:
 * 1. 服务器已启动 (端口 20003)
 * 2. 数据库中已创建 Fusion 配置
 * 3. 有有效的 API Key
 */

const BASE_URL = 'http://localhost:20003';

// 测试配置
const TEST_CONFIG = {
  apiKey: process.env.TEST_API_KEY || 'your-api-key-here',
  messages: [
    { role: 'user', content: '请解释什么是量子计算，以及它与经典计算的主要区别是什么？' }
  ]
};

async function testFusionNonStream() {
  console.log('\n=== 测试 Fusion 非流式请求 ===\n');

  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        model: 'fusion',
        messages: TEST_CONFIG.messages,
        stream: false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('请求失败:', data);
      return;
    }

    console.log('✅ 请求成功');
    console.log('模型:', data.model);
    console.log('内容长度:', data.choices?.[0]?.message?.content?.length || 0);
    console.log('Token 用量:', data.usage);
    console.log('Fusion 信息:', data.fusion);
    console.log('\n回答预览:');
    console.log(data.choices?.[0]?.message?.content?.substring(0, 500) + '...');
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

async function testFusionStream() {
  console.log('\n=== 测试 Fusion 流式请求 ===\n');

  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        model: 'fusion',
        messages: TEST_CONFIG.messages,
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('请求失败:', error);
      return;
    }

    console.log('✅ 流式请求已发送');
    console.log('开始接收数据...\n');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalContent = '';
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            console.log('\n✅ 流式传输完成');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content || '';
            if (content) {
              totalContent += content;
              chunkCount++;
              process.stdout.write(content);
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    console.log(`\n\n统计: ${chunkCount} 个 chunk, 总长度 ${totalContent.length}`);
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

async function testFusionWithPreset() {
  console.log('\n=== 测试 Fusion 自定义预设 ===\n');

  try {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        model: 'fusion',
        fusion_preset: 'general',
        messages: TEST_CONFIG.messages,
        stream: false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('请求失败:', data);
      return;
    }

    console.log('✅ 请求成功');
    console.log('使用的预设:', data.fusion?.config || 'default');
    console.log('Panel 模型数:', data.fusion?.panel_count || 0);
    console.log('成功 Panel 数:', data.fusion?.panel_success || 0);
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

// 主函数
async function main() {
  console.log('🚀 CrewRouter Fusion 功能测试');
  console.log('================================');

  // 检查 API Key
  if (TEST_CONFIG.apiKey === 'your-api-key-here') {
    console.log('\n⚠️  请设置环境变量 TEST_API_KEY:');
    console.log('   export TEST_API_KEY=your-actual-api-key');
    console.log('   或修改脚本中的 TEST_CONFIG.apiKey');
    return;
  }

  // 运行测试
  await testFusionNonStream();
  await testFusionStream();
  await testFusionWithPreset();

  console.log('\n================================');
  console.log('✨ 测试完成');
}

main().catch(console.error);
