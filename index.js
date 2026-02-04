/**
 * 풍로 그룹 지급결제 시스템 - Slack 연동 서버
 * Slack Bolt SDK + AWS RDS PostgreSQL
 */

require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { Pool } = require('pg');

// ========================================
// 환경 변수
// ========================================
const {
  PORT = 3000,
  DATABASE_URL,
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_APPROVAL_CHANNEL,
} = process.env;

// ========================================
// PostgreSQL 연결
// ========================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err);
});

// ========================================
// Express Receiver
// ========================================
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
});

receiver.router.get('/', (req, res) => {
  res.json({
    name: '풍로 지급결제 서버',
    status: 'running',
    version: '3.0.0',
  });
});

receiver.router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ status: 'error', database: 'disconnected' });
  }
});

// ========================================
// Slack Bolt App
// ========================================
const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// ========================================
// 매장-채널 매핑
// ========================================
let STORE_CHANNEL_MAP = {};

async function loadStoreChannelMap() {
  try {
    const { rows } = await pool.query('SELECT id, name, slack_channel_id FROM stores');
    STORE_CHANNEL_MAP = {};
    rows.forEach((store) => {
      if (store.slack_channel_id) {
        STORE_CHANNEL_MAP[store.slack_channel_id] = {
          store_id: store.id,
          name: store.name,
        };
      }
    });
    console.log('📍 Store-Channel map loaded:', Object.keys(STORE_CHANNEL_MAP).length, 'stores');
  } catch (error) {
    console.error('Failed to load store-channel map:', error);
  }
}

// ========================================
// 지급요청 메시지 파싱
// ========================================
function parsePaymentRequest(text) {
  const patterns = {
    amount: /금액[:\s]*([0-9,]+)\s*원?/i,
    category: /카테고리[:\s]*([가-힣a-zA-Z]+)/i,
    description: /내용[:\s]*(.+?)(?:\n|$)/i,
    vendor: /거래처[:\s]*(.+?)(?:\n|$)/i,
  };

  const simplePattern = /^([0-9,]+)\s+([가-힣]+)\s+(.+)$/;
  const simpleMatch = text.trim().match(simplePattern);
  if (simpleMatch) {
    return {
      amount: parseInt(simpleMatch[1].replace(/,/g, '')),
      category: simpleMatch[2],
      description: simpleMatch[3],
      vendor: null,
    };
  }

  // 패턴: "지급요청 100,000원 거래처 내용"
  const requestPattern = /지급\s*요청\s+([0-9,]+)\s*원?\s+(\S+)\s+(.+)/;
  const requestMatch = text.match(requestPattern);
  if (requestMatch) {
    return {
      amount: parseInt(requestMatch[1].replace(/,/g, '')),
      category: '기타',
      description: requestMatch[3].trim(),
      vendor: requestMatch[2],
    };
  }

  // 패턴: "지급요청 100,000원 내용"
  const requestPattern2 = /지급\s*요청\s+([0-9,]+)\s*원?\s+(.+)/;
  const requestMatch2 = text.match(requestPattern2);
  if (requestMatch2) {
    return {
      amount: parseInt(requestMatch2[1].replace(/,/g, '')),
      category: '기타',
      description: requestMatch2[2].trim(),
      vendor: null,
    };
  }

  const amount = text.match(patterns.amount);
  const category = text.match(patterns.category);
  const description = text.match(patterns.description);
  const vendor = text.match(patterns.vendor);

  if (amount) {
    return {
      amount: parseInt(amount[1].replace(/,/g, '')),
      category: category ? category[1] : '기타',
      description: description ? description[1].trim() : text.substring(0, 100),
      vendor: vendor ? vendor[1].trim() : null,
    };
  }

  return null;
}

// ========================================
// 거래처 ID 조회
// ========================================
async function findVendorId(vendorName) {
  if (!vendorName) return null;
  try {
    const { rows } = await pool.query(
      'SELECT id FROM vendors WHERE name ILIKE $1 LIMIT 1',
      [`%${vendorName}%`]
    );
    return rows[0]?.id || null;
  } catch (error) {
    console.error('❌ Vendor lookup error:', error);
    return null;
  }
}

// ========================================
// DB에 요청 저장
// ========================================
async function savePaymentRequest(request) {
  const { rows } = await pool.query(
    `INSERT INTO payment_requests
     (store_id, vendor_id, requester_name, amount, category, description, status, slack_channel_id, slack_message_ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      request.store_id,
      request.vendor_id,
      request.requester_name,
      request.amount,
      request.category,
      request.description,
      request.status,
      request.slack_channel_id,
      request.slack_message_ts,
    ]
  );
  console.log('✅ Payment request saved:', rows[0].id);
  return rows[0];
}

// ========================================
// Slack 승인 알림 전송
// ========================================
async function sendApprovalNotification(request, storeName, requesterName) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 새 지급결제 요청', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*🏪 매장:*\n${storeName}` },
        { type: 'mrkdwn', text: `*👤 요청자:*\n${requesterName}` },
        { type: 'mrkdwn', text: `*💰 금액:*\n${request.amount.toLocaleString()}원` },
        { type: 'mrkdwn', text: `*📁 카테고리:*\n${request.category}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*📝 내용:*\n${request.description}` },
    },
    {
      type: 'actions',
      block_id: `approval_${request.id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ 승인', emoji: true },
          style: 'primary',
          action_id: 'approve_payment',
          value: request.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ 거절', emoji: true },
          style: 'danger',
          action_id: 'reject_payment',
          value: request.id,
        },
      ],
    },
  ];

  try {
    const result = await app.client.chat.postMessage({
      channel: SLACK_APPROVAL_CHANNEL,
      text: `새 지급결제 요청: ${storeName} - ${request.amount.toLocaleString()}원`,
      blocks,
    });

    await pool.query('UPDATE payment_requests SET slack_message_ts = $1 WHERE id = $2', [
      result.ts,
      request.id,
    ]);

    console.log('📤 Approval notification sent');
    return result;
  } catch (error) {
    console.error('❌ Slack notification error:', error);
    throw error;
  }
}

// ========================================
// 메시지 이벤트 핸들러
// ========================================
app.message(async ({ message, say, client }) => {
  if (message.bot_id || message.subtype) return;

  const storeInfo = STORE_CHANNEL_MAP[message.channel];
  if (!storeInfo) return;

  const text = message.text || '';
  if (!text.includes('지급요청') && !text.includes('지급 요청') && !text.match(/^[0-9,]+\s+/)) {
    return;
  }

  console.log(`📨 Payment request received from ${storeInfo.name}`);

  try {
    const parsed = parsePaymentRequest(text);
    if (!parsed || !parsed.amount || parsed.amount < 1000) {
      await say({
        thread_ts: message.ts,
        text:
          '❌ 지급요청 형식을 확인해주세요.\n\n' +
          '*간단 형식:*\n`150000 식자재 채소류 구매`\n\n' +
          '*상세 형식:*\n```\n[지급요청]\n금액: 150,000원\n카테고리: 식자재\n내용: 채소류 구매\n```',
      });
      return;
    }

    const userInfo = await client.users.info({ user: message.user });
    const requesterName = userInfo.user.real_name || userInfo.user.name;

    const vendorId = await findVendorId(parsed.vendor);

    const request = await savePaymentRequest({
      store_id: storeInfo.store_id,
      vendor_id: vendorId,
      requester_name: requesterName,
      amount: parsed.amount,
      category: parsed.category,
      description: parsed.description,
      status: 'pending',
      slack_channel_id: message.channel,
      slack_message_ts: message.ts,
    });

    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'eyes',
    });

    await sendApprovalNotification(request, storeInfo.name, requesterName);

    await say({
      thread_ts: message.ts,
      text:
        `✅ 지급요청이 접수되었습니다.\n\n` +
        `💰 금액: ${parsed.amount.toLocaleString()}원\n` +
        `📁 카테고리: ${parsed.category}\n` +
        `📝 내용: ${parsed.description}\n\n` +
        `승인 대기 중입니다. 처리되면 알려드릴게요!`,
    });
  } catch (error) {
    console.error('❌ Message handler error:', error);
    await say({
      thread_ts: message.ts,
      text: '⚠️ 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
});

// ========================================
// 승인 버튼 핸들러
// ========================================
app.action('approve_payment', async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  console.log(`✅ Approving payment request: ${requestId}`);

  try {
    const { rows } = await pool.query(
      `UPDATE payment_requests
       SET status = 'approved', processed_at = NOW(), processed_by = $1
       WHERE id = $2
       RETURNING *`,
      [body.user.name, requestId]
    );
    const request = rows[0];

    const newBlocks = body.message.blocks.slice(0, -1);
    newBlocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `✅ *승인됨* by ${body.user.name} (${new Date().toLocaleString('ko-KR')})`,
        },
      ],
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ 승인됨 - ${request.amount.toLocaleString()}원`,
      blocks: newBlocks,
    });

    if (request.slack_channel_id) {
      await client.chat.postMessage({
        channel: request.slack_channel_id,
        thread_ts: request.slack_message_ts,
        text:
          `✅ *지급결제가 승인되었습니다!*\n\n` +
          `💰 금액: ${request.amount.toLocaleString()}원\n` +
          `📝 내용: ${request.description}\n` +
          `⏰ 승인일시: ${new Date().toLocaleString('ko-KR')}`,
      });
    }
  } catch (error) {
    console.error('❌ Approve action error:', error);
  }
});

// ========================================
// 거절 버튼 핸들러
// ========================================
app.action('reject_payment', async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  console.log(`❌ Rejecting payment request: ${requestId}`);

  try {
    const { rows } = await pool.query(
      `UPDATE payment_requests
       SET status = 'rejected', processed_at = NOW(), processed_by = $1
       WHERE id = $2
       RETURNING *`,
      [body.user.name, requestId]
    );
    const request = rows[0];

    const newBlocks = body.message.blocks.slice(0, -1);
    newBlocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `❌ *거절됨* by ${body.user.name} (${new Date().toLocaleString('ko-KR')})`,
        },
      ],
    });

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ 거절됨 - ${request.amount.toLocaleString()}원`,
      blocks: newBlocks,
    });

    if (request.slack_channel_id) {
      await client.chat.postMessage({
        channel: request.slack_channel_id,
        thread_ts: request.slack_message_ts,
        text:
          `❌ *지급결제가 거절되었습니다.*\n\n` +
          `💰 금액: ${request.amount.toLocaleString()}원\n` +
          `📝 내용: ${request.description}\n` +
          `⏰ 처리일시: ${new Date().toLocaleString('ko-KR')}\n\n` +
          `궁금한 점이 있으면 담당자에게 문의해주세요.`,
      });
    }
  } catch (error) {
    console.error('❌ Reject action error:', error);
  }
});

// ========================================
// 슬래시 커맨드: /지급요청
// ========================================
app.command('/지급요청', async ({ command, ack, respond }) => {
  await ack();

  const storeInfo = STORE_CHANNEL_MAP[command.channel_id];
  if (!storeInfo) {
    await respond('⚠️ 이 채널에서는 지급요청을 할 수 없습니다. 지정된 지급결제 채널에서 요청해주세요.');
    return;
  }

  const parsed = parsePaymentRequest(command.text);
  if (!parsed || !parsed.amount) {
    await respond({
      text: '❌ 사용법: `/지급요청 [금액] [카테고리] [내용]`\n\n예시: `/지급요청 150000 식자재 채소류 구매`',
    });
    return;
  }

  try {
    const vendorId = await findVendorId(parsed.vendor);

    const request = await savePaymentRequest({
      store_id: storeInfo.store_id,
      vendor_id: vendorId,
      requester_name: command.user_name,
      amount: parsed.amount,
      category: parsed.category,
      description: parsed.description,
      status: 'pending',
      slack_channel_id: command.channel_id,
      slack_message_ts: null,
    });

    await sendApprovalNotification(request, storeInfo.name, command.user_name);

    await respond({
      text:
        `✅ 지급요청이 접수되었습니다!\n\n` +
        `💰 금액: ${parsed.amount.toLocaleString()}원\n` +
        `📁 카테고리: ${parsed.category}\n` +
        `📝 내용: ${parsed.description}\n\n` +
        `승인되면 알려드릴게요!`,
    });
  } catch (error) {
    console.error('❌ Command error:', error);
    await respond('⚠️ 요청 처리 중 오류가 발생했습니다.');
  }
});

// ========================================
// 서버 시작
// ========================================
(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL connected');
  } catch (error) {
    console.error('❌ PostgreSQL connection failed:', error);
    process.exit(1);
  }

  await loadStoreChannelMap();

  await app.start({ port: PORT, host: '0.0.0.0' });

  console.log('');
  console.log('🚀 ================================');
  console.log('🚀 풍로 지급결제 서버 실행 중');
  console.log(`🚀 Port: ${PORT}`);
  console.log('🚀 Database: AWS RDS PostgreSQL');
  console.log('🚀 ================================');
  console.log('');
})();
