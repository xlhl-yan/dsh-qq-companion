/**
 * QQ 工具集：agent 用来"看群 / 说话 / 等回复 / 标已读"的原生工具。
 *
 * 为什么是原生工具而不是 MCP
 * -------------------------
 * 这是整个重做方案的核心收益。qq-bridge 为了实现这些能力，不得不：
 *   ① 维护一个独立进程；
 *   ② 在里面自建 38 个工具的 MCP server；
 *   ③ 再让 DSH 通过 stdio 去连它。
 * 插件内 `ctx.tools.register()` 一步到位 —— 没有进程边界，没有 MCP 协议往返，
 * 工具直接读写同一份内存状态（缓冲、水位、唤醒配置）。
 *
 * 为什么手写 ToolDefinition 而不是 defineTool()
 * --------------------------------------------
 * 外部插件解析不到 `@deepseek-ai/dsh-tools`（实测 ERR_MODULE_NOT_FOUND）。
 * 但 registry 只认形状、不认出处，所以按 defineTool 的产物手写即可：
 *   { name, description, parameters(标准 JSON Schema), output: { schema, render }, execute }
 * 注意 parameters 要**编译后的**标准 JSON Schema，不是官方源码里那种简写 spec。
 */

import { sendImage, sendVoice, uploadPrivateFile } from './onebot.js';


const KEY_DESCRIPTION =
  'QQ 会话标识，形如 group:123456（群聊）或 private:789012（私聊）。来自唤醒提示或 qq_social_state。';

/** 统一把 JSON 值渲染成给模型看的文本块。 */
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/**
 * @param {import('./runtime.js').QQCompanionRuntime} runtime
 * @returns {Array<object>} 可直接交给 ctx.tools.register() 的 ToolDefinition 数组
 */
export function createQQTools(runtime) {
  return [
    {
      name: 'qq_send_message',
      description:
        '在 QQ 里发消息。这是唯一能把话发到 QQ 的方式 —— 你的文本输出不会自动发出去。' +
        '**想连发几句就传数组**（一次调用发多条，对方看到多个气泡，比连续调用多次更像真人）；' +
        '只发一句就传字符串。不要用空格在一个元素里假装停顿 —— 那是假分条。' +
        '返回值里 ok 表示「全部成功」，要看每一条的结果用 sent。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          messages: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
            description:
              '要发送的文本。传字符串 = 发一条；传数组 = 一次连发多条（每个元素一个气泡）。' +
              '不要用空格在单个元素里假装停顿 —— 那是假分条。',
          },
          delayMs: {
            type: 'number',
            description: '多条之间的间隔毫秒数，默认 400。',
          },
        },
        required: ['key', 'messages'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            sent: { type: 'array', items: { type: 'object' } },
            sentCount: { type: 'number' },
            failedCount: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key = String(args?.key ?? '');
        const messages = Array.isArray(args?.messages) ? args.messages : [args?.messages ?? ''];
        if (!/^(group|private):\d+$/.test(key)) {
          return { ok: false, error: `key 形状不合法：${key}` };
        }
        const result = await runtime.send(key, messages, { delayMs: args?.delayMs });
        // 把「部分成功」摊平到顶层：ok 只代表全部成功，模型需要知道发出去几条、
        // 失败几条 —— 否则只看到 ok:false 会以为整批都没发出去。
        const sent = result.sent ?? [];
        return {
          ok: result.ok,
          sent,
          sentCount: sent.filter((one) => one.ok).length,
          failedCount: sent.filter((one) => !one.ok).length,
          ...(result.error ? { error: result.error } : {}),
        };
      },
    },

    {
      name: 'qq_get_unread_messages',
      description:
        '查看某个 QQ 会话里还没读过的消息，以及当前已读水位。' +
        '每条带 seq（本地序号，标已读时要传它）、发送者、文本与消息段类型。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
        },
        required: ['key'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            messages: { type: 'array', items: { type: 'object' } },
            watermark: { type: 'number' },
            maxSeq: { type: 'number' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key = String(args?.key ?? '');
        const stats = runtime.buffer.stats(key);
        return {
          // 返回「还没标已读」的全部 —— 包括已投递但模型没确认的。
        // 只返回 ready 的话，模型收到"有 N 条"再调这个会是空数组（2026-11-16 反馈）。
        messages: runtime.pendingMessages(key),
          watermark: stats.watermark,
          maxSeq: stats.maxSeq,
        };
      },
    },

    {
      name: 'qq_mark_read',
      description:
        '把某个 QQ 会话的已读水位推进到 throughSeq（只能用 qq_get_unread_messages 里看到的 seq）。' +
        '水位只能前进，且不能超过已收到的最大 seq。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          throughSeq: { type: 'number', description: '读到的本地 seq 水位。' },
        },
        required: ['key', 'throughSeq'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            watermark: { type: 'number' },
            why: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return runtime.markRead(String(args?.key ?? ''), Number(args?.throughSeq));
      },
    },

    {
      name: 'qq_wait_for_messages',
      description:
        '挂起等待某个 QQ 会话的新消息（长轮询）。' +
        '当对方明显还没说完、或者你想等他的下一句时使用，比反复查询省事。' +
        '超时不算错误，返回 timeout=true 和期间收到的消息。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          timeoutMs: { type: 'number', description: '最长等待毫秒数，默认 60000，上限 600000。' },
          minCount: { type: 'number', description: '至少等到几条才算满足，默认 1。' },
        },
        required: ['key'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            timeout: { type: 'boolean' },
            messages: { type: 'array', items: { type: 'object' } },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return runtime.waitForMessages(String(args?.key ?? ''), {
          timeoutMs: Number(args?.timeoutMs) || 60000,
          minCount: Number(args?.minCount) || 1,
        });
      },
    },

    {
      name: 'qq_social_state',
      description:
        '查看 QQ 伴侣插件与某个会话的当前状态：是否连上协议端、是否观察模式、' +
        '当前唤醒配置、缓冲里有多少未读、已读水位。排查"它怎么不理我"时先调这个。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
        },
        required: ['key'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            selfId: { type: 'string' },
            connected: { type: 'boolean' },
            observedOnly: { type: 'boolean' },
            wake: { type: 'object' },
            buffer: { type: 'object' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return runtime.summary(String(args?.key ?? ''));
      },
    },

    {
      name: 'qq_send_image',
      description:
        '在 QQ 里发一张本地图片（png/jpg/jpeg/gif/webp/bmp）。' +
        'imagePath 传本地绝对路径，会以 base64 内联发送（不需要先上传）。' +
        '可选 caption 作为同一气泡的配文。单张上限 3 MiB。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          imagePath: {
            type: 'string',
            description: '本地图片的绝对路径。接收到的图片会落在状态目录的 images/ 下。',
          },
          caption: {
            type: 'string',
            description: '可选：同一气泡的配文（一句完整的话，别太长）。',
          },
        },
        required: ['key', 'imagePath'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            messageId: { type: 'number' },
            bytes: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key = String(args?.key ?? '');
        const matched = /^(group|private):(\d+)$/.exec(key);
        if (!matched) return { ok: false, error: `key 形状不合法：${key}` };
        if (!runtime.endpoint) return { ok: false, error: '协议端点未就绪' };
        const result = await sendImage({
          baseUrl: runtime.endpoint.baseUrl,
          token: runtime.endpoint.token,
          kind: matched[1],
          target: matched[2],
          imagePath: String(args?.imagePath ?? ''),
          caption: String(args?.caption ?? ''),
        });
        // 聊天日志要有来有回：图片也记一笔，"发了张图"同样是要复盘的信息。
        runtime.logOutgoing(key, result, '图片');
        // ⚠️ 成功时**不要**带 error 字段。
        //
        // 这里踩过一个连环坑：一开始返回 `error: undefined` —— 过不了 DSH 的
        // lossless JSON 校验（undefined 键会被 JSON.stringify 丢掉）；
        // 改成 `error: null` 之后又过不了 schema 校验，因为下面 properties 里
        // 写的是 `type: 'string'`，报 `"value.error" must be a string`。
        // 正确做法是**失败时才带这个字段**：schema 里没有 required，缺省合法。
        return result.error ? result : { ok: result.ok, messageId: result.messageId, bytes: result.bytes };
      },
    },

    {
      name: 'qq_send_voice',
      description:
        '在 QQ 里发一条语音。voicePath 传本地音频绝对路径（mp3/wav/ogg/amr/m4a/aac/flac 都行，' +
        'SnowLuma 会自动转成 QQ 的 silk 格式）。' +
        '**和发图片/发文件不同：这个不能带配文** —— 想同时说句话，发完语音再单独调 qq_send_message。' +
        '文件必须在 SnowLuma 所在的那台机器上。单条上限 20 MiB。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          voicePath: {
            type: 'string',
            description: '本地音频文件的绝对路径。',
          },
        },
        required: ['key', 'voicePath'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            messageId: { type: 'number' },
            bytes: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key = String(args?.key ?? '');
        const matched = /^(group|private):(\d+)$/.exec(key);
        if (!matched) return { ok: false, error: `key 形状不合法：${key}` };
        if (!runtime.endpoint) return { ok: false, error: '协议端点未就绪' };
        const result = await sendVoice({
          baseUrl: runtime.endpoint.baseUrl,
          token: runtime.endpoint.token,
          kind: matched[1],
          target: matched[2],
          voicePath: String(args?.voicePath ?? ''),
        });
        runtime.logOutgoing(key, result, '语音');
        // 成功时不带 error 字段（理由见 qq_send_image 的注释）。
        return result.error ? result : { ok: result.ok, messageId: result.messageId, bytes: result.bytes };
      },
    },

    {
      name: 'qq_send_file',
      description:
        '在 QQ 里发一个文件（不是图片，是"上传文件并发送"）。' +
        'filePath 传本地绝对路径，name 可指定对方看到的文件名（默认用原文件名）。' +
        '注意：这个动作**不能带配文** —— 想附一句话，发完文件后再单独调 qq_send_message。' +
        '视频走这里对方收到的是「文件」，点开才能播，不是点一下就播的视频消息。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: KEY_DESCRIPTION },
          filePath: {
            type: 'string',
            description: '本地文件的绝对路径（D:\\path\\file.mp4）。文件必须在 DSH 这台机器上、且 SnowLuma 能读到。',
          },
          name: {
            type: 'string',
            description: '可选：对方看到的文件名，比如 "成品.mp4"。不传就用原文件名。',
          },
        },
        required: ['key', 'filePath'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            fileId: { type: 'string' },
            bytes: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key = String(args?.key ?? '');
        const matched = /^(group|private):(\d+)$/.exec(key);
        if (!matched) return { ok: false, error: `key 形状不合法：${key}` };
        if (!runtime.endpoint) return { ok: false, error: '协议端点未就绪' };
        const result = await uploadPrivateFile({
          baseUrl: runtime.endpoint.baseUrl,
          token: runtime.endpoint.token,
          kind: matched[1],
          target: matched[2],
          filePath: String(args?.filePath ?? ''),
          name: String(args?.name ?? ''),
        });
        runtime.logOutgoingFile(key, result);
        return result.error ? result : { ok: result.ok, fileId: result.fileId, bytes: result.bytes };
      },
    },

    {
      name: 'qq_chat_log_path',
      description:
        '告诉你 QQ 聊天记录存在哪个文件（收到的每条、发出的每条都记在里面，带时间戳和 message_id）。' +
        '想回查某段对话、或者确认某条消息到底有没有收发出去，就拿到 file 路径去读它。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '可选：QQ 会话标识。不传就用当前绑定的第一个会话。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            key: { type: 'string' },
            root: { type: 'string', description: '所有会话日志的根目录' },
            dir: { type: 'string', description: '这个会话的日志目录' },
            file: { type: 'string', description: '今天的日志文件（完整路径）' },
            day: { type: 'string' },
            exists: { type: 'boolean', description: '今天的文件是不是已经存在了' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const key =
          String(args?.key ?? '').trim() || String(runtime.config.bindings?.[0]?.key ?? '').trim();
        if (key === '') {
          // 没绑定任何会话时也要给个完整形状：字段全给，别留 undefined
          // （DSH 对工具返回值有无损 JSON 校验，undefined 键会被拒）。
          return { ok: false, key: '', root: '', dir: '', file: '', day: '', exists: false };
        }
        const info = runtime.chatLogPath(key);
        return { ok: true, key, ...info };
      },
    },
  ];
}
