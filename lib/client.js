window.__ModuleLoader__.load({
  id: 'dsh-webhook-notify',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'webhookNotify';
    const ROUTES = {
      state: '/webhook-notify/state',
      save: '/webhook-notify/save',
      test: '/webhook-notify/test',
      preview: '/webhook-notify/preview',
      sw: '/webhook-notify/sw.js',
      pushKey: '/webhook-notify/push/key',
      pushSubscribe: '/webhook-notify/push/subscribe',
      pushUnsubscribe: '/webhook-notify/push/unsubscribe',
      pushTest: '/webhook-notify/push/test',
      pushList: '/webhook-notify/push/list',
    };

    // ── 浏览器通知（参考 dsh-notify-me）────────────────────────────────
    // 通知本体走 Service Worker（页面被挂起后仍能弹、点击还能带回用户手势），
    // 没有 worker 时退回页面内 new Notification()。触发规则与 webhook 同源：
    // 同一批事件，webhook 推到端点、浏览器通知弹到系统通知中心。
    const BRIDGE_CHANNEL = 'dsh-webhook-notify:bridge';
    const NOTIFICATION_TAG_PREFIX = 'dsh-webhook-notify-';

    const DICTS = {
      zh: {
        nav: 'Webhook 通知',
        title: 'Webhook 通知',
        intro:
          '任务需要你操作、回复完成或本轮出错时，把通知推到你自己的端点。请求由 DSH 宿主发出，没有浏览器跨域限制，可自定义方法、请求头与请求体。',
        masterAttention: '需要你操作时推送',
        masterAttentionHint: '工具审批等需要人做决定时推送。',
        masterDone: '回复完成时推送',
        masterDoneHint: '一轮回复正常结束时推送。',
        masterError: '本轮出错时推送',
        masterErrorHint: '模型或工具以错误结束时推送。',
        throttle: '同一会话最小间隔',
        throttleHint: '毫秒。0 表示不限制；设 3000 可避免连续回合刷屏。',
        textTemplate: '正文模板',
        textTemplateHint: '留空用内置排版。可用变量：{{title}} {{body}} {{session}} {{tool}} {{time}} {{kind}}',
        endpoints: '推送端点',
        endpointsHint: '可加多个，每个端点独立配置地址、方法、请求头、请求体和订阅的事件类型。',
        addEndpoint: '添加端点',
        removeEndpoint: '删除',
        endpointName: '备注名',
        endpointNameHint: '只用于这里显示与日志，可留空',
        url: '地址',
        urlHint: '必填。可含模板变量，如 https://example.com/hook?kind={{kind}}',
        method: '方法',
        headers: '请求头',
        headersHint: '每行一条 Key: Value。例如 Authorization: Bearer xxx',
        bodyMode: '请求体',
        bodyModeJson: '通用 JSON（默认）',
        bodyModeText: '纯文本正文',
        bodyModeNone: '不带请求体',
        bodyTemplate: '自定义请求体模板',
        bodyTemplateHint:
          '留空则用上面的模式生成。以 { 开头按 JSON 拼装（变量自动转义），否则按纯文本。可用 {{content}} {{title}} {{body}} {{json}} 等。',
        kinds: '订阅事件',
        kindsHint: '不选=全部接收。',
        kindAttention: '需要你',
        kindDone: '回复完成',
        kindError: '出错',
        kindNotice: '测试/其它',
        retries: '重试次数',
        timeout: '超时(ms)',
        enabled: '启用',
        test: '发送测试消息',
        testing: '发送中…',
        preview: '预览请求',
        previewing: '生成中…',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        recent: '最近投递',
        recentEmpty: '还没有投递记录。',
        resultOk: '成功',
        resultFail: '失败',
        previewTitle: '请求预览',
        noEndpoints: '还没有端点，点「添加端点」开始。',
        sample: '示例',
        webhook: 'Webhook 投递',
        webhookHint: '选择哪些事件触发投递，并调整正文排版与日志。',
        disabled: '已停用',
        defaultTimeout: '默认请求超时',
        defaultTimeoutHint: '毫秒。端点没单独设置超时时用它；端点里填 0 即跟随这里。',
        timeoutDefaultHint: '毫秒。0 = 跟随插件默认请求超时。',
        retriesHint: '失败后额外重试的次数（最多 4 次）。',
        logDeliveries: '记录投递日志',
        logDeliveriesHint: '在宿主日志里记录每次投递的结果，排查问题时很有用。',
        debug: '调试日志',
        debugHint: '额外输出节流等细节，平时保持关闭。',
        saveHint: '改完点保存写回 profile 配置。',
        browser: '浏览器通知',
        browserHint:
          '除了推送 Webhook，也在系统通知中心弹一条浏览器通知（参考 dsh-notify-me）：页面开着也能立刻看到，点击通知会把窗口带到前台并切到对应会话。',
        browserEnable: '启用浏览器通知',
        browserEnableHint: '总开关。需要先授予浏览器通知权限。',
        browserAttention: '「需要你操作」弹通知',
        browserAttentionHint: '工具审批等需要人做决定时弹系统通知。',
        browserDone: '「回复完成」弹通知',
        browserDoneHint: '一轮回复正常结束时弹通知。',
        browserError: '「本轮出错」弹通知',
        browserErrorHint: '模型或工具以错误结束时弹通知。',
        browserCurrentQuiet: '当前对话不弹通知',
        browserCurrentQuietHint: '默认开启：等待就发生在你正看着的对话里时，卡片就在眼前，弹通知只会挡住它。',
        browserDoneHiddenOnly: '「回复完成」只在页面隐藏时弹',
        browserDoneHiddenOnlyHint: '默认开启，避免打断；关掉后页面开着也弹。',
        browserIgnoreSubagent: '子代理会话不弹通知',
        browserIgnoreSubagentHint: '默认开启：后台子代理是主对话的步骤，由主对话的提醒覆盖。',
        browserAutoFocus: '点击通知回到对应对话',
        browserAutoFocusHint: '默认开启：点击通知把 DSH 带到前台并切到该会话。',
        browserPermission: '通知权限',
        browserPermissionGranted: '已授予',
        browserPermissionDenied: '已拒绝（需在浏览器地址栏的站点设置里改）',
        browserPermissionDefault: '尚未询问（点下面的按钮授权）',
        browserPermissionUnsupported: '当前环境不支持浏览器通知',
        browserRequestPermission: '请求通知权限',
        browserTest: '发送测试通知',
        browserTestSent: '测试通知已发送',
        browserTestBlocked: '通知未发出：请先授予通知权限',
        browserBridge: '连接状态',
        browserBridgeActive: '持久通知已就绪（Service Worker）',
        browserBridgeIdle: '未注册 Service Worker（通知仍可用，页面关闭后不再弹）',
        browserTitle: 'DSH · 需要你操作',
        browserDoneTitle: 'DSH · 回复完成',
        browserErrorTitle: 'DSH · 本轮出错',
        browserTestTitle: 'DSH · 测试通知',
        browserTestBody: '这是一条来自 dsh-webhook-notify 的测试通知',
        push: 'Web Push',
        pushHint:
          '页面全关也能收到提醒：需要在浏览器里授权通知并订阅推送，之后宿主用 VAPID 签名直接投到推送服务。',
        pushEnable: '启用 Web Push',
        pushEnableHint: '总开关。打开后，事件发生时会向已订阅的浏览器推送。',
        pushPermission: '推送订阅',
        pushStateIdle: '未订阅',
        pushStateUnsupported: '当前环境不支持 Web Push',
        pushStateSubscribed: '已订阅',
        pushStateDenied: '订阅被拒绝（需要安全上下文，且通知权限已授予）',
        pushSubscribe: '订阅推送',
        pushUnsubscribe: '退订',
        pushTest: '发送测试推送',
        pushSent: '测试推送已发出',
        pushFailed: '推送失败',
        pushSubs: '订阅端点',
        pushNoSubs: '还没有订阅。',
        pushSubject: 'VAPID 联系地址',
        pushSubjectHint: '推送服务会联系这个地址，必须以 mailto: 或 https: 开头。',
        pushProxy: '推送代理',
        pushProxyHint:
          '宿主只能经代理出网时填这里（例如 http://127.0.0.1:7890）。留空=直连；只作用于 Web Push，不影响 Webhook 投递。',
      },
      en: {
        nav: 'Webhook Notify',
        title: 'Webhook Notify',
        intro:
          'Push a notification to your own endpoint when the agent needs you, a reply finishes, or a turn fails. Requests are sent by the DSH host: no browser CORS, and the method, headers and body are yours to define.',
        masterAttention: 'Notify when the agent needs you',
        masterAttentionHint: 'Tool approvals and other decisions waiting on a human.',
        masterDone: 'Notify when a reply finishes',
        masterDoneHint: 'A turn ended normally.',
        masterError: 'Notify when a turn fails',
        masterErrorHint: 'The model or a tool ended the turn with an error.',
        throttle: 'Per-session minimum interval',
        throttleHint: 'Milliseconds. 0 disables it; 3000 avoids spamming on rapid turns.',
        textTemplate: 'Body template',
        textTemplateHint: 'Empty uses the built-in layout. Variables: {{title}} {{body}} {{session}} {{tool}} {{time}} {{kind}}',
        endpoints: 'Endpoints',
        endpointsHint: 'Add as many as you need; each has its own URL, method, headers, body and event filter.',
        addEndpoint: 'Add endpoint',
        removeEndpoint: 'Remove',
        endpointName: 'Label',
        endpointNameHint: 'Shown here and in logs; optional',
        url: 'URL',
        urlHint: 'Required. Template variables allowed, e.g. https://example.com/hook?kind={{kind}}',
        method: 'Method',
        headers: 'Headers',
        headersHint: 'One Key: Value per line, e.g. Authorization: Bearer xxx',
        bodyMode: 'Body',
        bodyModeJson: 'Generic JSON (default)',
        bodyModeText: 'Plain text body',
        bodyModeNone: 'No body',
        bodyTemplate: 'Custom body template',
        bodyTemplateHint:
          'Empty uses the mode above. Templates starting with { are built as JSON (variables escaped), otherwise plain text. Variables: {{content}} {{title}} {{body}} {{json}}.',
        kinds: 'Events',
        kindsHint: 'None selected = all events.',
        kindAttention: 'Needs you',
        kindDone: 'Reply done',
        kindError: 'Error',
        kindNotice: 'Test / other',
        retries: 'Retries',
        timeout: 'Timeout (ms)',
        enabled: 'Enabled',
        test: 'Send test',
        testing: 'Sending…',
        preview: 'Preview request',
        previewing: 'Building…',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        recent: 'Recent deliveries',
        recentEmpty: 'No deliveries yet.',
        resultOk: 'ok',
        resultFail: 'failed',
        previewTitle: 'Request preview',
        noEndpoints: 'No endpoints yet — click "Add endpoint".',
        sample: 'sample',
        webhook: 'Webhook delivery',
        webhookHint: 'Which events fire, plus the shared body layout and logging.',
        disabled: 'Disabled',
        defaultTimeout: 'Default request timeout',
        defaultTimeoutHint: 'Milliseconds. Used when an endpoint has no timeout of its own; an endpoint timeout of 0 follows this value.',
        timeoutDefaultHint: 'Milliseconds. 0 = follow the plugin default request timeout.',
        retriesHint: 'Extra attempts after a failure (4 max).',
        logDeliveries: 'Log deliveries',
        logDeliveriesHint: 'Record every delivery result in the host log — handy when troubleshooting.',
        debug: 'Debug logging',
        debugHint: 'Also logs throttling details. Keep it off normally.',
        saveHint: 'Save writes the settings back to the profile config.',
        browser: 'Browser notifications',
        browserHint:
          'Besides pushing to webhooks, also raise a system notification (like dsh-notify-me): see it right away even with the page open, and clicking the notification brings the window forward and opens the matching conversation.',
        browserEnable: 'Enable browser notifications',
        browserEnableHint: 'Master switch. Requires notification permission first.',
        browserAttention: 'Notify on "needs you"',
        browserAttentionHint: 'Raise a system notification when a tool approval or other decision waits on you.',
        browserDone: 'Notify on "reply finished"',
        browserDoneHint: 'Raise a notification when a turn ends normally.',
        browserError: 'Notify on "turn failed"',
        browserErrorHint: 'Raise a notification when the model or a tool ends the turn with an error.',
        browserCurrentQuiet: 'Stay quiet for the current conversation',
        browserCurrentQuietHint: 'On by default: a wait inside the conversation already on screen has its card right there — a notification would only cover it.',
        browserDoneHiddenOnly: '"Reply finished" only when the page is hidden',
        browserDoneHiddenOnlyHint: 'On by default to avoid interruptions; turn off to notify while the page is open.',
        browserIgnoreSubagent: 'Mute subagent sessions',
        browserIgnoreSubagentHint: 'On by default: background subagents are steps of the main conversation, covered by its own reminder.',
        browserAutoFocus: 'Clicking a notification focuses its conversation',
        browserAutoFocusHint: 'On by default: bring DSH forward and switch to that conversation.',
        browserPermission: 'Notification permission',
        browserPermissionGranted: 'granted',
        browserPermissionDenied: 'denied (change it in the browser site settings)',
        browserPermissionDefault: 'not asked yet (use the button below)',
        browserPermissionUnsupported: 'browser notifications are unavailable here',
        browserRequestPermission: 'Request permission',
        browserTest: 'Send test notification',
        browserTestSent: 'Test notification sent',
        browserTestBlocked: 'Notification not shown: grant notification permission first',
        browserBridge: 'Bridge status',
        browserBridgeActive: 'Persistent notifications ready (Service Worker)',
        browserBridgeIdle: 'No Service Worker registered (notifications still work while the page is open)',
        browserTitle: 'DSH · Needs you',
        browserDoneTitle: 'DSH · Reply finished',
        browserErrorTitle: 'DSH · Turn failed',
        browserTestTitle: 'DSH · Test notification',
        browserTestBody: 'This is a test notification from dsh-webhook-notify',
        push: 'Web Push',
        pushHint:
          'Notifications even with the page closed: grant notification permission and subscribe in the browser, then the host signs the payload with VAPID and hands it to the push service.',
        pushEnable: 'Enable Web Push',
        pushEnableHint: 'Master switch. When on, events are pushed to every subscribed browser.',
        pushPermission: 'Push subscription',
        pushStateIdle: 'not subscribed',
        pushStateUnsupported: 'Web Push is unavailable here',
        pushStateSubscribed: 'subscribed',
        pushStateDenied: 'subscription denied (needs a secure context and granted notification permission)',
        pushSubscribe: 'Subscribe to push',
        pushUnsubscribe: 'Unsubscribe',
        pushTest: 'Send test push',
        pushSent: 'Test push sent',
        pushFailed: 'Push failed',
        pushSubs: 'Subscription endpoints',
        pushNoSubs: 'No subscriptions yet.',
        pushSubject: 'VAPID contact',
        pushSubjectHint: 'The push service contacts this address; it must start with mailto: or https:.',
        pushProxy: 'Push proxy',
        pushProxyHint:
          'Fill this when the host can only reach the internet through a proxy (e.g. http://127.0.0.1:7890). Empty = direct; applies to Web Push only, not webhook deliveries.',
      },
    };

    function useLocaleRevision(ctx) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!ctx.locale?.subscribe) return undefined;
        return ctx.locale.subscribe(() => force((n) => n + 1));
      }, [ctx]);
    }

    function readLocale(ctx) {
      try {
        return ctx.locale?.getSnapshot?.()?.locale ?? 'zh';
      } catch {
        return 'zh';
      }
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
      });
      const payload = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, payload };
    }

    async function getJson(path) {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return {};
      return res.json().catch(() => ({}));
    }

    // ── 浏览器通知运行时 ────────────────────────────────────────────
    // 与 lib/browser-notify.js 的 createNotifier 同一套逻辑，内联进 bundle，
    // 避免 require() 逃逸到加载器模块表之外。改动请两处同步。
    //
    // 关键行为（两处必须一致）：
    // - 点击消息只挂一种 BroadcastChannel 监听（同时挂 addEventListener 和
    //   onmessage 会让同一条消息导航两次）；
    // - show() 是 async：showNotification 的 Promise 必须 await + catch，
    //   否则一次拒绝就是 unhandledRejection，而调用方还以为通知发出去了；
    // - dispose() 释放全部监听、定时器与页面通知，卸载后不再触发回调。
    const PAGE_NOTIFICATION_TTL = 15000;

    function createNotifier(options = {}) {
      const {
        notify: NotificationCtor,
        serviceWorker,
        BroadcastChannel: ChannelCtor,
        onNavigate = () => {},
        onResubscribe = () => {},
        getTag = (kind, key) => `${NOTIFICATION_TAG_PREFIX}${key ?? kind}`,
        getIcon = () => undefined,
        bridgeTimeoutMs = 2000,
      } = options;

      let registration = null;
      let bridgeState = 'idle';
      let bridgeListening = false;
      let permissionPending = null;
      let disposed = false;
      let bridgePending = null;
      const pageNotifications = new Set();
      const pageTimers = new Set();
      const cleanups = [];

      const canNotify = () => {
        try {
          return typeof NotificationCtor === 'function' && NotificationCtor.permission === 'granted';
        } catch {
          return false;
        }
      };

      const currentPermission = () => {
        try {
          if (typeof NotificationCtor !== 'function') return 'unsupported';
          return NotificationCtor.permission;
        } catch {
          return 'unsupported';
        }
      };

      const requestPermission = async () => {
        try {
          if (typeof NotificationCtor !== 'function') return 'unsupported';
          if (NotificationCtor.permission === 'granted') return 'granted';
          if (NotificationCtor.permission === 'denied') return 'denied';
          // 并发调用共用同一次询问；结果停在 default 时下次仍可再问。
          if (permissionPending) return permissionPending;
          permissionPending = (async () => {
            try {
              const pending = NotificationCtor.requestPermission();
              if (pending && typeof pending.then === 'function') await pending;
            } catch {
              /* 权限请求失败不阻断提醒 */
            }
            return currentPermission();
          })().finally(() => {
            permissionPending = null;
          });
          return await permissionPending;
        } catch {
          return currentPermission();
        }
      };

      const handleBridgeMessage = (message) => {
        if (disposed) return;
        if (!message || message.source !== 'dsh-webhook-notify') return;
        // 订阅被浏览器轮换：重新订阅并上报宿主。
        if (message.type === 'pushsubscriptionchange') {
          try {
            onResubscribe();
          } catch {
            /* ignore */
          }
          return;
        }
        if (message.type !== 'notificationclick') return;
        try {
          onNavigate({
            sessionId: message.sessionId ?? null,
            kind: message.kind ?? null,
            navigate: message.navigate !== false,
            autoFocus: message.autoFocus !== false,
          });
        } catch {
          /* 回调异常不影响后续点击 */
        }
      };

      const listenBridge = () => {
        if (bridgeListening || disposed) return;
        bridgeListening = true;
        try {
          if (typeof ChannelCtor === 'function') {
            const channel = new ChannelCtor(BRIDGE_CHANNEL);
            const listener = (event) => handleBridgeMessage(event?.data);
            channel.addEventListener?.('message', listener);
            cleanups.push(() => {
              try {
                channel.close();
              } catch {
                /* ignore */
              }
            });
          }
        } catch {
          /* 没有 BroadcastChannel 就只走 serviceWorker 消息 */
        }
        try {
          if (serviceWorker && typeof serviceWorker.addEventListener === 'function') {
            const listener = (event) => handleBridgeMessage(event?.data);
            serviceWorker.addEventListener('message', listener);
            cleanups.push(() => {
              try {
                serviceWorker.removeEventListener?.('message', listener);
              } catch {
                /* ignore */
              }
            });
          }
        } catch {
          /* ignore */
        }
      };

      const ensureBridge = (scriptUrl) => {
        if (disposed || bridgeState === 'active' || bridgeState === 'registering') return bridgePending ?? undefined;
        listenBridge();
        try {
          if (!serviceWorker || typeof serviceWorker.register !== 'function') {
            bridgeState = 'unsupported: no service worker';
            return undefined;
          }
          bridgeState = 'registering';
          const pending = serviceWorker.register(scriptUrl, { scope: '/' });
          if (!pending || typeof pending.then !== 'function') {
            bridgeState = 'failed: register() did not return a promise';
            return undefined;
          }
          bridgePending = pending.then(
            (reg) => {
              if (disposed) return null;
              registration = reg || null;
              if (reg && reg.active) {
                bridgeState = 'active';
                return reg;
              }
              const worker = reg && (reg.installing || reg.waiting);
              if (!worker) {
                bridgeState = 'active';
                return reg;
              }
              const onChange = () => {
                if (disposed) return;
                try {
                  if (reg.active || worker.state === 'activated') bridgeState = 'active';
                  else if (worker.state === 'redundant') bridgeState = 'failed: worker redundant';
                } catch {
                  /* ignore */
                }
              };
              worker.addEventListener?.('statechange', onChange);
              cleanups.push(() => {
                try {
                  worker.removeEventListener?.('statechange', onChange);
                } catch {
                  /* ignore */
                }
              });
              return reg;
            },
            (error) => {
              if (!disposed) bridgeState = `failed: ${error?.message || error}`;
              return null;
            },
          );
          return bridgePending;
        } catch (error) {
          bridgeState = `failed: ${error?.message || error}`;
          return undefined;
        }
      };

      const awaitBridge = async () => {
        if (!bridgePending || bridgeState === 'active') return;
        let timer;
        try {
          await Promise.race([
            bridgePending,
            new Promise((resolve) => {
              timer = setTimeout(resolve, Math.max(0, bridgeTimeoutMs));
              pageTimers.add(timer);
            }),
          ]);
        } finally {
          if (timer) {
            clearTimeout(timer);
            pageTimers.delete(timer);
          }
        }
      };

      const showPageNotification = (payload, title, tag, icon) => {
        const { kind = 'notice', sessionId = null, silent = true, autoFocus = true, onClick } = payload;
        try {
          const options = { body: payload.body ?? '', tag, renotify: true, silent };
          if (icon) options.icon = icon;
          const instance = new NotificationCtor(title, options);
          pageNotifications.add(instance);
          if (typeof onClick === 'function') {
            instance.onclick = () => {
              try {
                onClick({ sessionId, kind, navigate: true, autoFocus });
              } finally {
                try {
                  instance.close();
                } catch {
                  /* ignore */
                }
                pageNotifications.delete(instance);
              }
            };
          }
          const timer = setTimeout(() => {
            pageTimers.delete(timer);
            try {
              instance.close();
            } catch {
              /* ignore */
            }
            pageNotifications.delete(instance);
          }, PAGE_NOTIFICATION_TTL);
          pageTimers.add(timer);
          return 'page';
        } catch {
          return 'skipped';
        }
      };

      const show = async (payload = {}) => {
        if (disposed || !canNotify()) return 'skipped';
        const {
          kind = 'notice',
          key,
          title = '',
          body = '',
          sessionId = null,
          silent = true,
          autoFocus = true,
          onClick,
        } = payload;
        const tag = getTag(kind, key);
        const icon = getIcon();
        if (bridgeState === 'registering') await awaitBridge();
        if (registration && typeof registration.showNotification === 'function') {
          try {
            // autoFocus 必须随通知一起落到 worker：点击是在 worker 里处理的，
            // 那里读不到页面配置，不带上它「点击回到对应对话」的开关就形同虚设。
            const options = { body, tag, renotify: true, silent, data: { sessionId, kind, autoFocus } };
            if (icon) options.icon = icon;
            await registration.showNotification(title, options);
            return 'sw';
          } catch {
            /* worker 通知不可用 → 页面通知 */
          }
        }
        return showPageNotification({ kind, body, sessionId, silent, autoFocus, onClick }, title, tag, icon);
      };

      const closeTag = async (kind, key) => {
        try {
          if (registration && typeof registration.getNotifications === 'function') {
            const list = await registration.getNotifications({ tag: getTag(kind, key) });
            for (const notification of list ?? []) {
              try {
                notification.close();
              } catch {
                /* ignore */
              }
            }
          }
        } catch {
          /* ignore */
        }
      };

      const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const timer of pageTimers) clearTimeout(timer);
        pageTimers.clear();
        for (const notification of pageNotifications) {
          try {
            notification.close();
          } catch {
            /* ignore */
          }
        }
        pageNotifications.clear();
        for (const fn of cleanups.splice(0)) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
        registration = null;
        bridgePending = null;
        bridgeState = 'idle';
      };

      return {
        ensureBridge,
        show,
        closeTag,
        requestPermission,
        canNotify,
        currentPermission,
        dispose,
        get bridgeState() {
          return bridgeState;
        },
        get registration() {
          return registration;
        },
      };
    }

    /** 浏览器通知的运行时状态（apply() 里按需初始化）。 */
    let notifier = null;
    /** 读取当前通知权限：granted | denied | default | unsupported。 */
    function readPermission() {
      try {
        if (typeof window === 'undefined' || typeof window.Notification !== 'function') return 'unsupported';
        return window.Notification.permission;
      } catch {
        return 'unsupported';
      }
    }
    /** 当前页面可见性。 */
    const pageHidden = () => {
      try {
        return document.hidden || document.visibilityState === 'hidden';
      } catch {
        return false;
      }
    };

    // ── Web Push 运行时 ────────────────────────────────────────────
    // 页面全关也能收到提醒，订阅信息存在宿主侧。
    const pushState = { state: 'idle', error: '', subs: [], count: 0 };

    /** base64url → Uint8Array（applicationServerKey 要用裸字节）。 */
    function base64ToBytes(base64String) {
      const padding = '='.repeat((4 - (String(base64String).length % 4)) % 4);
      const base64 = (String(base64String) + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const output = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
      return output;
    }

    /** 读取宿主侧的推送状态（VAPID 公钥、订阅列表）。 */
    async function readPushStatus() {
      try {
        const [keyRes, listRes] = await Promise.all([
          fetch(ROUTES.pushKey, { cache: 'no-store' }),
          fetch(ROUTES.pushList, { cache: 'no-store' }),
        ]);
        const key = await keyRes.json().catch(() => ({}));
        const list = await listRes.json().catch(() => ({}));
        pushState.count = Number(key?.count) || 0;
        pushState.subs = Array.isArray(list?.subscriptions) ? list.subscriptions : [];
        pushState.vapidKey = key?.publicKey || '';
        return key;
      } catch {
        return null;
      }
    }

    /** 订阅 Web Push（先要通知权限，再向浏览器要订阅，最后上报宿主）。 */
    async function subscribePush() {
      pushState.error = '';
      try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          pushState.state = 'unsupported';
          return false;
        }
        if (typeof window.Notification === 'function' && window.Notification.permission === 'default') {
          await window.Notification.requestPermission();
        }
        if (typeof window.Notification === 'function' && window.Notification.permission !== 'granted') {
          pushState.state = 'denied';
          return false;
        }
        const registration = await navigator.serviceWorker.ready;
        const key = await readPushStatus();
        const publicKey = key?.publicKey || '';
        if (!publicKey) {
          pushState.state = 'error';
          pushState.error = '宿主没有提供 VAPID 公钥';
          return false;
        }
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing
          ?? (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64ToBytes(publicKey),
          }));
        // 上报失败不能算订阅成功：宿主没记下这个端点，之后永远收不到推送。
        const reported = await postJson(ROUTES.pushSubscribe, { subscription: subscription.toJSON() });
        if (!reported.ok || reported.payload?.ok === false || reported.payload?.persisted === false) {
          pushState.state = 'error';
          pushState.error = reported.payload?.error || `HTTP ${reported.status}`;
          // 浏览器侧已经订阅、宿主没记下：撤销，保持两边一致。
          try {
            await subscription.unsubscribe();
          } catch {
            /* ignore */
          }
          return false;
        }
        pushState.state = 'subscribed';
        await readPushStatus();
        return true;
      } catch (error) {
        pushState.state = 'error';
        pushState.error = error?.message || String(error);
        return false;
      }
    }

    /** 退订 Web Push。 */
    async function unsubscribePush() {
      pushState.error = '';
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          // 先让宿主忘掉端点，再取消浏览器订阅：反过来会留下宿主还在推、
          // 浏览器已失效的僵尸订阅（每次投递都 410）。
          const removed = await postJson(ROUTES.pushUnsubscribe, { endpoint: subscription.endpoint });
          if (!removed.ok || removed.payload?.ok === false) {
            pushState.state = 'error';
            pushState.error = removed.payload?.error || `HTTP ${removed.status}`;
            return false;
          }
          await subscription.unsubscribe();
        }
        pushState.state = 'idle';
        await readPushStatus();
        return true;
      } catch (error) {
        pushState.state = 'error';
        pushState.error = error?.message || String(error);
        return false;
      }
    }

    /** 订阅失效时（浏览器轮换了订阅）自动重新订阅。 */
    async function resubscribePush() {
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) return false;
        return await subscribePush();
      } catch {
        return false;
      }
    }

    /**
     * 弹一条浏览器通知。
     *
     * @param raw {kind, title, body, sessionId, toolName, reason}。
     * @param config 当前配置（读取静音/自动聚焦开关）。
     * @returns {Promise<boolean>} 是否真的弹了。
     */
    async function fireBrowserNotification(raw, config) {
      if (!config?.browserNotify) return false;
      const kind = raw.kind ?? 'notice';
      if (kind === 'attention' && config.browserAttention === false) return false;
      if (kind === 'done' && config.browserDone === false) return false;
      if (kind === 'error' && config.browserError === false) return false;
      if (!notifier) return false;
      // 「回复完成」默认只在页面隐藏时弹，避免打断。
      if (kind === 'done' && config.browserDoneHiddenOnly !== false && !pageHidden()) return false;
      try {
        const shown = await notifier.show({
          kind,
          key: `${kind}:${raw.sessionId ?? 'global'}:${Date.now()}`,
          title: raw.title ?? '',
          body: raw.body ?? '',
          sessionId: raw.sessionId ?? null,
          // 由系统按通知设置发声；插件不自带音效，避免与系统音叠加。
          silent: false,
          // 开关随通知带走：worker 侧据此决定点击时是否抢焦点/切会话。
          autoFocus: config.browserAutoFocus !== false,
          onClick: (info) => {
            if (config.browserAutoFocus === false) return;
            try {
              if (info?.navigate !== false) focusSession(raw.sessionId ?? null);
            } catch {
              /* ignore */
            }
          },
        });
        return shown !== 'skipped';
      } catch {
        return false;
      }
    }

    /** 把焦点带回 DSH 并切到指定会话（尽力而为，任何一步失败都不致命）。 */
    function focusSession(sessionId) {
      try {
        if (typeof window !== 'undefined') window.focus();
      } catch {
        /* ignore */
      }
      if (!sessionId || typeof window === 'undefined') return;
      try {
        // sessions.open()（旧）/ uiWorkspace.openSession()（新）两条路径都试。
        const root = window.__DSH_HOOKS__ || window;
        const sessions = root.sessions;
        if (sessions && typeof sessions.open === 'function') {
          sessions.open(sessionId);
          return;
        }
      } catch {
        /* ignore */
      }
      try {
        // 退回 URL hash 切换，至少把会话标识带到地址栏。
        if (window.location && typeof window.location.assign === 'function') {
          window.location.hash = `#session=${encodeURIComponent(sessionId)}`;
        }
      } catch {
        /* ignore */
      }
    }

    const EMPTY = {
      endpoints: [],
      notifyAttention: true,
      notifyDone: true,
      notifyError: true,
      minIntervalMs: 0,
      timeoutMs: 10000,
      textTemplate: '',
      logDeliveries: true,
      debug: false,
      // ── 浏览器通知 ──
      browserNotify: true,
      browserAttention: true,
      browserDone: true,
      browserError: true,
      browserCurrentQuiet: true,
      browserDoneHiddenOnly: true,
      browserIgnoreSubagent: true,
      browserAutoFocus: true,
      // ── Web Push ──
      pushEnabled: false,
      pushSubject: 'mailto:dsh-webhook-notify@localhost',
      pushProxy: '',
    };

    // DSH 的设置页把原子组件作为外部模块暴露（dsh-better-sidebar 等外部插件都
    // 直接 require，不需要写进 dsh.client.inject）。拿到就用，拿不到就退回下面
    // 自绘的 .wn-* 等价样式——两条路视觉一致，行为不依赖 DSH 内部哈希 class。
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null;
    } catch {
      primitives = null;
    }
    // 组件可能来自 React.forwardRef/React.memo（typeof 是 'object'），
    // 所以不能只判 typeof function，认一下 React 元素类型标记即可。
    const isComponent = (value) =>
      typeof value === 'function' || (value !== null && typeof value === 'object' && Boolean(value.$$typeof));
    const PrimButton = isComponent(primitives?.Button) ? primitives.Button : null;
    const PrimSwitch = isComponent(primitives?.Switch) ? primitives.Switch : null;
    const PrimPill = isComponent(primitives?.Pill) ? primitives.Pill : null;

    function Panel({ ctx, t }) {
      const [config, setConfig] = React.useState(EMPTY);
      const [recent, setRecent] = React.useState([]);
      const [note, setNote] = React.useState('');
      const [noteTone, setNoteTone] = React.useState('info');
      const [busy, setBusy] = React.useState('');
      const [previews, setPreviews] = React.useState(null);
      const [perm, setPerm] = React.useState(() => readPermission());
      const [bridge, setBridge] = React.useState(() => (notifier ? notifier.bridgeState : 'idle'));
      const [pushBusy, setPushBusy] = React.useState('');
      const [, forcePushRerender] = React.useState(0);

      const pushStateText = () => {
        if (pushState.state === 'subscribed') return t('pushStateSubscribed');
        if (pushState.state === 'unsupported') return t('pushStateUnsupported');
        if (pushState.state === 'denied') return t('pushStateDenied');
        if (pushState.state === 'error') return pushState.error || t('pushFailed');
        return t('pushStateIdle');
      };
      const pushErrorText = () => pushState.error || t('pushFailed');

      React.useEffect(() => {
        let alive = true;
        getJson(ROUTES.state).then((data) => {
          if (!alive) return;
          if (data?.config) setConfig({ ...EMPTY, ...data.config });
          if (Array.isArray(data?.recent)) setRecent(data.recent);
        });
        return () => {
          alive = false;
        };
      }, []);

      // 权限与 Service Worker 状态会变（授权后、注册完成后），定时刷一下即可。
      React.useEffect(() => {
        let tick = 0;
        const id = setInterval(() => {
          setPerm(readPermission());
          if (notifier) setBridge(notifier.bridgeState);
          // 订阅列表变动不频繁，隔几秒拉一次就够。
          tick += 1;
          if (tick % 4 === 0) {
            void readPushStatus().then(() => forcePushRerender((n) => n + 1));
          }
        }, 1500);
        return () => clearInterval(id);
      }, []);

      const patch = (fields) => setConfig((cur) => ({ ...cur, ...fields }));

      const patchEndpoint = (index, fields) =>
        setConfig((cur) => {
          const endpoints = cur.endpoints.map((item, i) => (i === index ? { ...item, ...fields } : item));
          return { ...cur, endpoints };
        });

      const addEndpoint = () =>
        setConfig((cur) => ({
          ...cur,
          endpoints: [
            ...cur.endpoints,
            {
              id: '',
              name: '',
              enabled: true,
              url: '',
              method: 'POST',
              headers: {},
              bodyMode: 'json',
              body: '',
              retries: 0,
              // 0 = 跟随插件级「默认请求超时」，避免新端点悄悄钉死一个值。
              timeoutMs: 0,
              kinds: [],
            },
          ],
        }));

      const removeEndpoint = (index) =>
        setConfig((cur) => ({ ...cur, endpoints: cur.endpoints.filter((_, i) => i !== index) }));

      const save = async () => {
        setBusy('save');
        setNote('');
        try {
          const { ok, status, payload } = await postJson(ROUTES.save, config);
          if (payload?.config) setConfig({ ...EMPTY, ...payload.config });
          // 保存即生效到浏览器通知运行时（权威配置回写后同步）。
          syncBrowserConfig(payload?.config ?? config);
          const fine = Boolean(payload?.ok);
          setNoteTone(fine ? 'ok' : 'error');
          setNote(fine ? t('saved') : `${t('saveFailed')}：${payload?.error ?? `HTTP ${status}`}`);
          void ok;
        } catch (error) {
          setNoteTone('error');
          setNote(`${t('saveFailed')}：${error?.message || error}`);
        } finally {
          setBusy('');
        }
      };

      const runTest = async (endpointId) => {
        setBusy(`test:${endpointId ?? 'all'}`);
        setNote('');
        try {
          const { status, payload } = await postJson(ROUTES.test, endpointId ? { endpointId } : {});
          const results = Array.isArray(payload?.results) ? payload.results : [];
          if (results.length === 0) {
            setNoteTone('error');
            setNote(payload?.error || t('noEndpoints'));
          } else {
            setNoteTone(results.every((r) => r.ok) ? 'ok' : 'error');
            setNote(
              results
                .map((r) => `${r.name || r.id}: ${r.ok ? t('resultOk') : `${t('resultFail')} ${r.error ?? ''}`}`)
                .join(' · '),
            );
          }
          // 测试接口返回的是投递结果，没有 `at` 字段；补上时间戳，
          // 否则刚测完的那一条会在列表里显示成 Invalid Date。
          if (Array.isArray(payload?.results)) {
            const at = Date.now();
            setRecent((cur) => [...payload.results.map((item) => ({ at, ...item })), ...cur].slice(0, 20));
          }
          void status;
        } catch (error) {
          setNoteTone('error');
          setNote(`${t('saveFailed')}：${error?.message || error}`);
        } finally {
          setBusy('');
        }
      };

      const preview = async () => {
        setBusy('preview');
        try {
          const { payload } = await postJson(ROUTES.preview, config);
          setPreviews(Array.isArray(payload?.previews) ? payload.previews : []);
        } catch (error) {
          setPreviews([{ id: 'error', name: t('previewTitle'), error: error?.message || String(error) }]);
        } finally {
          setBusy('');
        }
      };

      // ── 展示积木（对齐 DSH 设置页：标签左 / 控件右、行间分隔线）────

      /** 开关：DSH 用的是 36×20 的胶囊按钮，不是浏览器默认的方框勾选。 */
      const switchControl = (checked, onChange, label) => {
        if (PrimSwitch) {
          return h(PrimSwitch, {
            checked: !!checked,
            onChange: (next) => onChange(Boolean(next)),
            label: label || undefined,
          });
        }
        return h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label || undefined,
          className: 'wn-switch',
          onClick: () => onChange(!checked),
        });
      };

      /**
       * 按钮：优先用 DSH 的 Button，缺模块时退回自绘。
       *
       * danger 变体 DSH 没有，只能自绘，所以那种情况一律不走 primitives。
       */
      const button = (text, options = {}) => {
        const { onClick, disabled, variant = 'outline', size = 'sm', title, danger = false } = options;
        if (PrimButton && !danger) {
          return h(PrimButton, { variant, size, onClick, disabled, title }, text);
        }
        const classes = ['wn-btn'];
        if (size === 'sm') classes.push('wn-btnSm');
        if (variant === 'primary') classes.push('wn-primary');
        if (danger) classes.push('wn-danger');
        return h('button', { type: 'button', className: classes.join(' '), onClick, disabled, title }, text);
      };

      const row = (label, hint, control, options = {}) => {
        const parts = [];
        if (label || hint) {
          parts.push(
            h('div', { className: 'wn-rowText', key: 'text' }, [
              label ? h('div', { className: 'wn-rowLabel' }, label) : null,
              hint ? h('div', { className: 'wn-rowHint' }, hint) : null,
            ]),
          );
        }
        if (control !== null && control !== undefined) {
          parts.push(h('div', { className: 'wn-rowControl', key: 'control' }, control));
        }
        return h(
          'div',
          {
            className: `wn-row${options.block ? ' wn-rowBlock' : ''}${options.top ? ' wn-rowTop' : ''}`,
          },
          parts,
        );
      };

      /** 文本域 / 长输入占整行：标签在上，控件在下。 */
      const blockRow = (label, hint, control) => row(label, hint, control, { block: true });

      const groupHead = (title, hint, action) =>
        h('div', { className: 'wn-groupHead' }, [
          h('div', { className: 'wn-groupText', key: 'text' }, [
            h('h3', { className: 'wn-groupTitle' }, title),
            hint ? h('p', { className: 'wn-groupHint' }, hint) : null,
          ]),
          action ? h('div', { className: 'wn-rowControl' }, action) : null,
        ]);

      const group = (title, hint, children, action) =>
        h('section', { className: 'wn-group' }, [groupHead(title, hint, action), h('div', { className: 'wn-groupBody' }, children)]);

      /** 订阅事件的多选胶囊（DSH 的 Pill 就是这种可选胶囊）。 */
      const chip = (on, onChange, label) => {
        if (PrimPill) return h(PrimPill, { active: !!on, onClick: () => onChange(!on), title: label }, label);
        return h(
          'button',
          {
            type: 'button',
            role: 'checkbox',
            'aria-checked': on ? 'true' : 'false',
            className: 'wn-chip',
            'data-on': on ? 'true' : 'false',
            onClick: () => onChange(!on),
          },
          label,
        );
      };

      const textInput = (value, onChange, extra = {}) =>
        h('input', {
          className: 'wn-input',
          value: value ?? '',
          onChange: (e) => onChange(e.currentTarget.value),
          ...extra,
        });

      const numberInput = (value, onChange, extra = {}) =>
        h('input', {
          className: 'wn-input wn-num',
          type: 'number',
          min: 0,
          value: value ?? 0,
          onChange: (e) => onChange(Number(e.currentTarget.value) || 0),
          ...extra,
        });

      const select = (value, onChange, options) =>
        h(
          'select',
          { className: 'wn-select', value, onChange: (e) => onChange(e.currentTarget.value) },
          options.map((item) => h('option', { value: item.value, key: item.value }, item.label)),
        );

      const endpointCard = (endpoint, index) => {
        const busyKey = `test:${endpoint.id}`;
        return h('div', { className: 'wn-card', key: endpoint.id || `new-${index}` }, [
          h('div', { className: 'wn-cardHead' }, [
            h('input', {
              className: 'wn-input wn-cardName',
              value: endpoint.name ?? '',
              placeholder: t('endpointName'),
              'aria-label': t('endpointName'),
              onChange: (e) => patchEndpoint(index, { name: e.currentTarget.value }),
            }),
            h('label', { className: 'wn-cardSwitch' }, [
              switchControl(
                endpoint.enabled,
                (v) => patchEndpoint(index, { enabled: v }),
                t('enabled'),
              ),
              h('span', null, endpoint.enabled ? t('enabled') : t('disabled')),
            ]),
            h('span', { className: 'wn-cardSpacer' }),
            button(t('removeEndpoint'), { danger: true, onClick: () => removeEndpoint(index) }),
          ]),
          blockRow(t('url'), t('urlHint'), [
            textInput(endpoint.url, (v) => patchEndpoint(index, { url: v }), { placeholder: 'https://…' }),
          ]),
          row(t('method'), null, [
            select(
              endpoint.method ?? 'POST',
              (v) => patchEndpoint(index, { method: v }),
              ['POST', 'PUT', 'PATCH', 'GET'].map((m) => ({ value: m, label: m })),
            ),
          ]),
          row(t('kinds'), t('kindsHint'), [
            h('div', { className: 'wn-rowControl', style: { gap: '8px' } }, [
              ...['attention', 'done', 'error', 'notice'].map((kind) => {
                const label = t(`kind${kind[0].toUpperCase()}${kind.slice(1)}`);
                return chip((endpoint.kinds ?? []).includes(kind), (on) => {
                  const cur = new Set(endpoint.kinds ?? []);
                  if (on) cur.add(kind);
                  else cur.delete(kind);
                  patchEndpoint(index, { kinds: [...cur] });
                }, label);
              }),
            ]),
          ]),
          row(t('timeout'), t('timeoutDefaultHint'), [
            numberInput(endpoint.timeoutMs ?? 0, (v) => patchEndpoint(index, { timeoutMs: v }), {
              step: 1000,
              'aria-label': t('timeout'),
            }),
          ]),
          row(t('retries'), t('retriesHint'), [
            numberInput(endpoint.retries ?? 0, (v) => patchEndpoint(index, { retries: Math.min(4, v) }), {
              max: 4,
              'aria-label': t('retries'),
            }),
          ]),
          row(t('bodyMode'), null, [
            select(
              endpoint.bodyMode ?? 'json',
              (v) => patchEndpoint(index, { bodyMode: v }),
              [
                { value: 'json', label: t('bodyModeJson') },
                { value: 'text', label: t('bodyModeText') },
                { value: 'none', label: t('bodyModeNone') },
              ],
            ),
          ]),
          blockRow(t('headers'), t('headersHint'), [
            h('textarea', {
              className: 'wn-textarea',
              rows: 3,
              value: headersToText(endpoint.headers),
              placeholder: 'Authorization: Bearer xxx',
              onChange: (e) => patchEndpoint(index, { headers: textToHeaders(e.currentTarget.value) }),
            }),
          ]),
          blockRow(t('bodyTemplate'), t('bodyTemplateHint'), [
            h('textarea', {
              className: 'wn-textarea',
              rows: 4,
              value: endpoint.body ?? '',
              placeholder: '{"content":"{{content}}"}',
              onChange: (e) => patchEndpoint(index, { body: e.currentTarget.value }),
            }),
          ]),
          row(null, null, [
            button(busy === busyKey ? t('testing') : t('test'), {
              disabled: busy === busyKey,
              onClick: () => runTest(endpoint.id || undefined),
            }),
          ]),
        ]);
      };

      const permissionHint = {
        granted: t('browserPermissionGranted'),
        denied: t('browserPermissionDenied'),
        default: t('browserPermissionDefault'),
        unsupported: t('browserPermissionUnsupported'),
      }[perm] ?? perm;

      return h('div', { className: 'wn-root' }, [
        h('div', { className: 'wn-head' }, [
          h('h2', { className: 'wn-title' }, t('title')),
          h('p', { className: 'wn-intro' }, t('intro')),
        ]),

        group(t('webhook'), t('webhookHint'), [
          row(t('masterAttention'), t('masterAttentionHint'), [
            switchControl(config.notifyAttention, (v) => patch({ notifyAttention: v }), t('masterAttention')),
          ]),
          row(t('masterDone'), t('masterDoneHint'), [
            switchControl(config.notifyDone, (v) => patch({ notifyDone: v }), t('masterDone')),
          ]),
          row(t('masterError'), t('masterErrorHint'), [
            switchControl(config.notifyError, (v) => patch({ notifyError: v }), t('masterError')),
          ]),
          row(t('defaultTimeout'), t('defaultTimeoutHint'), [
            numberInput(config.timeoutMs ?? 10000, (v) => patch({ timeoutMs: v }), { step: 1000 }),
          ]),
          row(t('throttle'), t('throttleHint'), [
            numberInput(config.minIntervalMs ?? 0, (v) => patch({ minIntervalMs: v }), { step: 1000 }),
          ]),
          blockRow(t('textTemplate'), t('textTemplateHint'), [
            h('textarea', {
              className: 'wn-textarea',
              rows: 2,
              value: config.textTemplate ?? '',
              placeholder: '{{title}}\n{{body}}',
              onChange: (e) => patch({ textTemplate: e.currentTarget.value }),
            }),
          ]),
          row(t('logDeliveries'), t('logDeliveriesHint'), [
            switchControl(config.logDeliveries, (v) => patch({ logDeliveries: v }), t('logDeliveries')),
          ]),
          row(t('debug'), t('debugHint'), [
            switchControl(config.debug, (v) => patch({ debug: v }), t('debug')),
          ]),
        ]),

        group(t('browser'), t('browserHint'), [
          row(t('browserEnable'), t('browserEnableHint'), [
            switchControl(config.browserNotify, (v) => patch({ browserNotify: v }), t('browserEnable')),
          ]),
          row(t('browserAttention'), t('browserAttentionHint'), [
            switchControl(config.browserAttention, (v) => patch({ browserAttention: v }), t('browserAttention')),
          ]),
          row(t('browserDone'), t('browserDoneHint'), [
            switchControl(config.browserDone, (v) => patch({ browserDone: v }), t('browserDone')),
          ]),
          row(t('browserError'), t('browserErrorHint'), [
            switchControl(config.browserError, (v) => patch({ browserError: v }), t('browserError')),
          ]),
          row(t('browserCurrentQuiet'), t('browserCurrentQuietHint'), [
            switchControl(config.browserCurrentQuiet, (v) => patch({ browserCurrentQuiet: v }), t('browserCurrentQuiet')),
          ]),
          row(t('browserDoneHiddenOnly'), t('browserDoneHiddenOnlyHint'), [
            switchControl(config.browserDoneHiddenOnly, (v) => patch({ browserDoneHiddenOnly: v }), t('browserDoneHiddenOnly')),
          ]),
          row(t('browserIgnoreSubagent'), t('browserIgnoreSubagentHint'), [
            switchControl(config.browserIgnoreSubagent, (v) => patch({ browserIgnoreSubagent: v }), t('browserIgnoreSubagent')),
          ]),
          row(t('browserAutoFocus'), t('browserAutoFocusHint'), [
            switchControl(config.browserAutoFocus, (v) => patch({ browserAutoFocus: v }), t('browserAutoFocus')),
          ]),
          row(t('browserPermission'), permissionHint, [
            button(t('browserRequestPermission'), {
              disabled: perm === 'granted' || perm === 'unsupported',
              onClick: async () => {
                try {
                  // requestPermission 是 async：等它落定再刷新状态，
                  // 比固定等 100ms 更准（用户可能停在询问框上很久）。
                  if (notifier) await notifier.requestPermission();
                  else if (typeof window !== 'undefined' && typeof window.Notification === 'function') {
                    await window.Notification.requestPermission();
                  }
                } catch {
                  /* ignore */
                }
                setPerm(readPermission());
              },
            }),
            button(t('browserTest'), {
              disabled: perm !== 'granted',
              onClick: async () => {
                // show 是 async：必须等结果，否则测试通知无论成败都显示「已发送」。
                const ok = await fireBrowserNotification(
                  { kind: 'notice', title: t('browserTestTitle'), body: t('browserTestBody'), sessionId: null },
                  config,
                );
                setNoteTone(ok ? 'ok' : 'error');
                setNote(ok ? t('browserTestSent') : t('browserTestBlocked'));
              },
            }),
          ]),
          row(
            t('browserBridge'),
            // 失败也要说出来：只显示「未注册」会让用户以为刷新一下就好，
            // 而实际原因（脚本 404、注册被拒）被吞掉了。
            bridge === 'active'
              ? t('browserBridgeActive')
              : bridge.startsWith('failed')
                ? `${t('browserBridgeIdle')} — ${bridge}`
                : t('browserBridgeIdle'),
            null,
          ),
        ]),

        group(t('push'), t('pushHint'), [
          row(t('pushEnable'), t('pushEnableHint'), [
            switchControl(config.pushEnabled, (v) => patch({ pushEnabled: v }), t('pushEnable')),
          ]),
          row(t('pushSubject'), t('pushSubjectHint'), [
            textInput(config.pushSubject, (v) => patch({ pushSubject: v }), { placeholder: 'mailto:me@example.com' }),
          ]),
          row(t('pushProxy'), t('pushProxyHint'), [
            textInput(config.pushProxy, (v) => patch({ pushProxy: v }), { placeholder: 'http://127.0.0.1:7890' }),
          ]),
          // 组的说明已经把订阅讲清楚了，这一行只放状态与按钮，避免把
          // 标签列压成两三个字一行。
          row(t('pushPermission'), null, [
            button(t('pushSubscribe'), {
              disabled: pushBusy || pushState.state === 'unsupported',
              onClick: async () => {
                setPushBusy('subscribe');
                try {
                  const ok = await subscribePush();
                  setNoteTone(ok ? 'ok' : 'error');
                  setNote(ok ? t('pushStateSubscribed') : pushErrorText());
                } catch (error) {
                  setNoteTone('error');
                  setNote(`${t('pushFailed')}：${error?.message || error}`);
                } finally {
                  setPushBusy('');
                  forcePushRerender((n) => n + 1);
                }
              },
            }),
            button(t('pushUnsubscribe'), {
              disabled: pushBusy || pushState.state === 'idle',
              onClick: async () => {
                setPushBusy('unsubscribe');
                try {
                  const ok = await unsubscribePush();
                  setNoteTone(ok ? 'ok' : 'error');
                  setNote(ok ? t('pushStateIdle') : pushErrorText());
                } catch (error) {
                  setNoteTone('error');
                  setNote(`${t('pushFailed')}：${error?.message || error}`);
                } finally {
                  setPushBusy('');
                  forcePushRerender((n) => n + 1);
                }
              },
            }),
            button(t('pushTest'), {
              disabled: pushBusy || (pushState.subs?.length ?? 0) === 0,
              onClick: async () => {
                setPushBusy('test');
                try {
                  const { payload } = await postJson(ROUTES.pushTest, {});
                  const results = Array.isArray(payload?.results) ? payload.results : [];
                  const failed = results.filter((item) => !item.ok);
                  setNoteTone(results.length > 0 && failed.length === 0 ? 'ok' : 'error');
                  setNote(
                    results.length === 0
                      ? (payload?.error || t('pushFailed'))
                      : failed.length === 0
                        ? t('pushSent')
                        : `${t('pushFailed')}：${failed.map((item) => `${item.host} ${item.error ?? ''}`).join(' · ')}`,
                  );
                } catch (error) {
                  setNoteTone('error');
                  setNote(`${t('pushFailed')}：${error?.message || error}`);
                } finally {
                  setPushBusy('');
                }
              },
            }),
            h('span', { className: 'wn-mono' }, pushStateText()),
          ]),
          blockRow(t('pushSubs'), null, [
            (pushState.subs?.length ?? 0) === 0
              ? h('span', { className: 'wn-mono' }, t('pushNoSubs'))
              : h(
                  'div',
                  { className: 'wn-rowControl', style: { gap: '8px' } },
                  pushState.subs.map((item) => h('span', { className: 'wn-mono', key: item.id || item.host }, item.host)),
                ),
          ]),
        ]),

        group(
          t('endpoints'),
          t('endpointsHint'),
          config.endpoints.length === 0
            ? h('div', { className: 'wn-empty' }, t('noEndpoints'))
            : config.endpoints.map((endpoint, index) => endpointCard(endpoint, index)),
          button(t('addEndpoint'), { onClick: addEndpoint }),
        ),

        h('div', { className: 'wn-actions' }, [
          h('span', { className: 'wn-hint' }, t('saveHint')),
          h('span', { className: 'wn-spacer' }),
          button(busy === 'preview' ? t('previewing') : t('preview'), {
            size: 'md',
            variant: 'outline',
            disabled: busy === 'preview',
            onClick: preview,
          }),
          button(busy === 'save' ? t('saving') : t('save'), {
            size: 'md',
            variant: 'primary',
            disabled: busy === 'save',
            onClick: save,
          }),
        ]),

        note ? h('div', { className: 'wn-note', 'data-tone': noteTone }, note) : null,

        previews && previews.length
          ? group(
              t('previewTitle'),
              null,
              previews.map((item) =>
                blockRow(null, null, [
                  item.error
                    ? h('span', { className: 'wn-rowHint' }, `${item.name || item.id}: ${item.error}`)
                    : h('pre', { className: 'wn-pre' }, [
                        `${item.method} ${item.url}\n${Object.entries(item.headers ?? {})
                          .map(([k, v]) => `${k}: ${v}`)
                          .join('\n')}\n\n${item.body}`,
                      ]),
                ]),
              ),
            )
          : null,

        group(
          t('recent'),
          null,
          recent.length === 0
            ? h('div', { className: 'wn-empty' }, t('recentEmpty'))
            : h(
                'div',
                { className: 'wn-list' },
                recent.map((item, index) =>
                  h('div', { className: 'wn-listRow', key: `${item.at}-${index}` }, [
                    h('span', null, formatTime(item.at)),
                    h('span', { className: 'wn-listOk' }, item.ok ? '✓' : '✗'),
                    h('span', null, item.kind ?? ''),
                    h('span', null, item.name || item.id || ''),
                    h('span', { className: item.ok ? 'wn-listOk' : 'wn-listFail' }, item.ok ? `OK ${item.status}` : `${item.error ?? ''}`),
                    h('span', null, `${item.ms}ms`),
                  ]),
                ),
              ),
        ),
      ]);
    }

    /** 投递记录的本地时间；缺字段时显示 --:--:-- 而不是 Invalid Date。 */
    function formatTime(value) {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) return '--:--:--';
      try {
        return new Date(ms).toLocaleTimeString();
      } catch {
        return '--:--:--';
      }
    }

    function headersToText(headers) {
      if (!headers) return '';
      if (typeof headers === 'string') return headers;
      return Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    }

    function textToHeaders(text) {
      const out = {};
      for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const at = trimmed.indexOf(':');
        if (at <= 0) continue;
        out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
      }
      return out;
    }

    // 样式按 DSH 设置页的实测规格来：14px 正文 / 12px 次要文字、16px 行距、
    // 行间 .5px 分隔线、控件 36px 高（圆角 12px）、开关 36×20。
    // 颜色一律走宿主的设计令牌（--dsw-*），拿不到时用同名回退值：
    // 这样浅色 / 深色主题都能自动跟随，不写死任何一套配色。
    const STYLE = `
.wn-root{--wn-label-1:var(--dsw-alias-label-primary,#0f1115);--wn-label-2:var(--dsw-alias-label-secondary,#61666b);--wn-label-3:var(--dsw-alias-label-tertiary,#81858c);--wn-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--wn-border-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.12));--wn-bg-subtle:var(--dsw-alias-bg-module-platform,#f5f6f7);--wn-bg-hover:var(--dsw-alias-interactive-bg-hover,#2631480f);--wn-brand:var(--dsw-alias-brand-primary,#0f1115);--wn-accent:var(--dsw-alias-state-business-primary,#4176e6);--wn-success:var(--dsw-alias-state-success-primary,#22c55e);--wn-danger:var(--dsw-alias-state-error-primary,#d5484a);--wn-bg:var(--dsw-alias-bg-base,#fff);--wn-primary-fill:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#0f1115));--wn-primary-hover:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#0f1115));--wn-on-primary:var(--dsw-alias-label-primary-foreground,#fff);--wn-card-stroke:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(0,0,0,.1)));--wn-card-fill:var(--dsw-alias-settings-card-fill,transparent);--wn-code-bg:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-module-platform,#f5f6f7));--wn-mono:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);--wn-ring:var(--dsw-focus-ring-width,2px);--wn-ring-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));--wn-radius-sm:var(--dsw-radius-sm,8px);--wn-radius-md:var(--dsw-radius-md,12px);--wn-radius-lg:var(--dsw-radius-lg,16px);display:flex;flex-direction:column;gap:26px;font-size:14px;line-height:22px;color:var(--wn-label-1)}
.wn-head{display:flex;flex-direction:column;gap:6px}
.wn-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--wn-label-1)}
.wn-intro{margin:0;font-size:12px;line-height:18px;color:var(--wn-label-3)}
.wn-group{display:flex;flex-direction:column}
.wn-groupHead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:2px}
.wn-groupText{display:flex;flex-direction:column;gap:2px;min-width:0}
.wn-groupTitle{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--wn-label-1)}
.wn-groupHint{margin:0;font-size:12px;line-height:18px;color:var(--wn-label-3)}
.wn-groupBody{display:flex;flex-direction:column}
.wn-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--wn-border)}
.wn-groupBody>.wn-row:last-child,.wn-card>.wn-row:last-child{border-bottom:none}
.wn-rowTop{align-items:flex-start}
.wn-rowText{flex:1 1 0%;min-width:0;display:flex;flex-direction:column;gap:4px;padding-right:48px}
.wn-rowLabel{font-size:14px;line-height:22px;color:var(--wn-label-1)}
.wn-rowHint{font-size:12px;line-height:18px;color:var(--wn-label-3);word-break:break-word}
.wn-rowControl{flex:0 1 auto;max-width:60%;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.wn-rowControl>*{min-width:0}
.wn-rowControl>.wn-mono{white-space:normal;overflow-wrap:anywhere;text-align:right}
.wn-rowControl>.wn-input,.wn-rowControl>.wn-select{width:auto;min-width:180px;max-width:260px}
.wn-rowControl>.wn-num{width:110px;min-width:110px}
.wn-rowBlock{flex-direction:column;align-items:stretch;gap:8px}
.wn-rowBlock .wn-rowText{padding-right:0}
.wn-rowBlock .wn-rowControl{width:100%;align-items:stretch;justify-content:flex-start;flex-direction:column;gap:8px}
.wn-rowBlock .wn-rowControl>.wn-input,.wn-rowBlock .wn-rowControl>.wn-select{max-width:none;min-width:0;width:100%}
.wn-rowBlock .wn-rowControl>.wn-mono{text-align:left}
.wn-input,.wn-select,.wn-textarea{box-sizing:border-box;width:100%;font:inherit;font-size:14px;color:var(--wn-label-1);background:var(--wn-bg-subtle);border:1px solid transparent;border-radius:var(--wn-radius-md);padding:0 12px;height:36px;transition:background .15s,border-color .15s}
.wn-input::placeholder,.wn-textarea::placeholder{color:var(--wn-label-3)}
.wn-input:hover,.wn-select:hover,.wn-textarea:hover{background:var(--wn-bg-hover)}
.wn-input:focus-visible,.wn-select:focus-visible,.wn-textarea:focus-visible{outline:var(--wn-ring) solid var(--wn-ring-color);outline-offset:1px;border-color:transparent;background:var(--wn-bg-subtle)}
.wn-select{appearance:none;-webkit-appearance:none;padding-right:28px;background-image:linear-gradient(45deg,transparent 50%,var(--wn-label-2) 50%),linear-gradient(135deg,var(--wn-label-2) 50%,transparent 50%);background-position:calc(100% - 16px) 15px,calc(100% - 11px) 15px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.wn-textarea{height:auto;padding:8px 12px;line-height:1.55;resize:vertical;font-family:var(--wn-mono);font-size:12px}
.wn-switch{position:relative;flex:0 0 auto;box-sizing:border-box;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--wn-border-strong);cursor:pointer;transition:background .18s}
.wn-switch::after{content:"";display:block;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .18s}
.wn-switch[aria-checked="true"]{background:var(--wn-brand)}
.wn-switch[aria-checked="true"]::after{transform:translateX(16px)}
.wn-switch:focus-visible{outline:var(--wn-ring) solid var(--wn-ring-color);outline-offset:2px}
.wn-switch:disabled{opacity:.5;cursor:default}
.wn-chip{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--wn-border-strong);border-radius:999px;background:transparent;color:var(--wn-label-2);font:inherit;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.wn-chip:hover{background:var(--wn-bg-hover)}
.wn-chip[data-on="true"]{background:var(--wn-bg-subtle);border-color:var(--wn-brand);color:var(--wn-label-1)}
.wn-chip:focus-visible{outline:var(--wn-ring) solid var(--wn-ring-color);outline-offset:2px}
.wn-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:0;border-radius:var(--wn-radius-md);background:var(--wn-bg-subtle);color:var(--wn-label-1);font:inherit;font-size:14px;cursor:pointer;transition:background .15s,opacity .15s}
.wn-btn:hover:not(:disabled){background:var(--wn-bg-hover)}
.wn-btn:focus-visible{outline:var(--wn-ring) solid var(--wn-ring-color);outline-offset:2px}
.wn-btn:disabled{opacity:.45;cursor:default}
.wn-btnSm{height:28px;padding:0 10px;font-size:12px;background:transparent;border:1px solid var(--wn-border-strong);border-radius:var(--wn-radius-sm)}
.wn-primary{background:var(--wn-primary-fill);color:var(--wn-on-primary)}
.wn-primary:hover:not(:disabled){background:var(--wn-primary-hover)}
.wn-danger{color:var(--wn-danger)}
.wn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.06));border-color:currentColor}
.wn-card{display:flex;flex-direction:column;border:.5px solid var(--wn-card-stroke);background:var(--wn-card-fill);border-radius:var(--wn-radius-lg);padding:0 16px;margin-bottom:12px}
.wn-card:last-of-type{margin-bottom:0}
.wn-cardHead{display:flex;align-items:center;gap:8px;padding:14px 0 10px;border-bottom:.5px solid var(--wn-border);flex-wrap:wrap}
.wn-cardName{width:auto;flex:1 1 160px;min-width:120px;max-width:260px;height:32px;font-size:13px}
.wn-cardSwitch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--wn-label-3)}
.wn-cardHead .wn-btn{margin-left:0}
.wn-cardSpacer{flex:1 1 auto}
.wn-note{padding:10px 12px;border-radius:var(--wn-radius-md);background:var(--wn-bg-subtle);color:var(--wn-label-2);font-size:12px;line-height:18px;word-break:break-word}
.wn-note[data-tone="error"]{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.06));color:var(--wn-danger)}
.wn-note[data-tone="ok"]{color:var(--wn-success)}
.wn-mono{font-family:var(--wn-mono);font-size:12px;line-height:18px;color:var(--wn-label-2);word-break:break-all}
.wn-hint{font-size:12px;line-height:18px;color:var(--wn-label-3)}
.wn-empty{padding:20px 16px;border:.5px dashed var(--wn-border-strong);border-radius:var(--wn-radius-md);color:var(--wn-label-3);font-size:12px;line-height:18px;text-align:center}
.wn-checks{display:flex;flex-direction:column;gap:6px}
.wn-check{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--wn-label-2)}
.wn-checkMark{flex:0 0 14px;width:14px;text-align:center;color:var(--wn-label-3)}
.wn-check[data-ok="true"] .wn-checkMark{color:var(--wn-success)}
.wn-check[data-ok="false"] .wn-checkMark{color:var(--wn-danger)}
.wn-list{display:flex;flex-direction:column}
.wn-listRow{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:.5px solid var(--wn-border);font-size:12px;line-height:18px;color:var(--wn-label-2);font-family:var(--wn-mono);word-break:break-all}
.wn-listRow:last-child{border-bottom:none}
.wn-listOk{color:var(--wn-success)}
.wn-listFail{color:var(--wn-danger)}
.wn-pre{margin:0;padding:12px;border-radius:var(--wn-radius-md);background:var(--wn-code-bg);font-family:var(--wn-mono);font-size:12px;line-height:1.55;color:var(--wn-label-2);white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto}
.wn-actions{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 14px;background:var(--wn-bg);border-top:.5px solid var(--wn-border)}
.wn-spacer{flex:1 1 auto}
@media (max-width:720px){.wn-root{gap:22px}.wn-row{flex-direction:column;align-items:flex-start;gap:6px}.wn-rowText{padding-right:0}.wn-rowControl{width:100%;justify-content:flex-start}.wn-rowControl>.wn-input,.wn-rowControl>.wn-select{max-width:none;flex:1 1 auto}.wn-card{padding:0 12px}}
`;

    // 注入（或更新）样式。
    // 只按 id 判重会让 HMR 之后仍留着旧样式表——改了 CSS 却看不到变化，
    // 所以内容不同时复用同一个 <style> 并替换文本。
    function injectStyle() {
      try {
        let el = document.getElementById('dsh-webhook-notify-style');
        if (el && el.textContent === STYLE) return;
        if (!el) {
          el = document.createElement('style');
          el.id = 'dsh-webhook-notify-style';
          document.head.appendChild(el);
        }
        el.textContent = STYLE;
      } catch {
        // 样式失败不影响功能。
      }
    }

    // ── 事件监听（浏览器通知的触发源）────────────────────────────────
    // 与 webhook 的宿主触发源对齐：审批/提问 → attention，回复完成 → done，
    // 本轮出错 → error。区别是这里读的是浏览器侧的会话服务
    // （uiSession.sessionStatus / sessions.list），页面开着就能弹。
    //
    // 服务不放进 inject：inject 是硬门（服务缺失整个 entry 不激活，web 启动
    // 审计还会报错），而不同宿主版本的服务名/形状都变过。用 ctx.get() 懒查。
    function lookupService(ctx, name) {
      let svc = null;
      try {
        if (ctx && typeof ctx.get === 'function') svc = ctx.get(name) || null;
      } catch {
        svc = null;
      }
      if (svc) return svc;
      try {
        if (ctx && ctx.reflect && typeof ctx.reflect.get === 'function') svc = ctx.reflect.get(name) || null;
      } catch {
        svc = null;
      }
      try {
        if (ctx && name in ctx) svc = ctx[name] || null;
      } catch {
        /* ignore */
      }
      return svc;
    }

    const isStore = (s) => !!s && typeof s.getSnapshot === 'function' && typeof s.subscribe === 'function';

    /** 取待处理交互源：sessionStatus（0.1.6+）或 pendingInteractions（0.1.2-0.1.5）。 */
    function interactionStore(svc) {
      if (svc && isStore(svc.sessionStatus)) return { store: svc.sessionStatus, source: 'sessionStatus' };
      if (svc && isStore(svc.pendingInteractions)) return { store: svc.pendingInteractions, source: 'pendingInteractions' };
      return null;
    }

    const pendingOf = (value, source) => {
      if (!value) return null;
      return source === 'sessionStatus' ? value.pendingInteraction || null : value;
    };

    /** 当前显示的会话 id（列表快照的 current，或 mainView 保留标记）。 */
    function currentSessionIdOf(listStore) {
      try {
        const st = listStore && listStore.getSnapshot();
        if (!st) return null;
        if (typeof st.current === 'string' && st.current) return st.current;
        const byId = st.byId || {};
        for (const id of Object.keys(byId)) {
          const row = byId[id];
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return id;
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    /** 后台子代理会话默认静默（origin==='subagent' 且不在当前屏）。 */
    function isSubagentSession(listStore, sid, currentId, ignore) {
      if (!ignore || !sid) return false;
      if ((currentId === undefined ? currentSessionIdOf(listStore) : currentId) === sid) return false;
      try {
        const st = listStore && listStore.getSnapshot();
        const sum = st && st.byId && st.byId[sid];
        if (sum && sum.origin === 'subagent') return true;
      } catch {
        /* ignore */
      }
      return false;
    }

    /**
     * 启动浏览器通知的事件监听。
     *
     * @param ctx cordis 客户端上下文。
     * @returns 停止函数。
     */
    function startBrowserWatchers(ctx) {
      const unsub = [];
      let disposed = false;
      // 已提醒过的待处理 key -> 会话 id。
      //
      // 必须是映射而不是 Set：宿主下发的 key 形如 `approval:<序号>` /
      // `question:<前缀>:<序号>`，**不含**会话 id，靠 key.split(':') 反推
      // 只会得到序号，清理逻辑会把刚加入的条目立刻抹掉，同一次等待于是被
      // 反复提醒。以 key 为键、会话 id 为值，清理时才判断得准。
      const attentionFired = new Map();
      // 已提醒过的完成（sessionId -> 时间戳），压掉同一完成的多次视图。
      const doneFiredAt = new Map();
      const DONE_DEDUPE_MS = 250;

      const configNow = () => readBrowserConfig();

      const fireAttention = (kind, sessionId, detail) => {
        const cfg = configNow();
        if (!cfg.browserNotify || cfg.browserAttention === false) return;
        const isCurrent = sessionId && sessionId === currentSessionIdOf(listStore);
        if (isCurrent && cfg.browserCurrentQuiet !== false && !pageHidden()) return;
        void fireBrowserNotification(
          {
            kind: 'attention',
            title: localeText('browserTitle'),
            body: detail || '',
            sessionId,
          },
          cfg,
        );
      };

      const reportDone = (sessionId, snippet) => {
        const cfg = configNow();
        if (!cfg.browserNotify || cfg.browserDone === false) return;
        const now = Date.now();
        const last = doneFiredAt.get(sessionId);
        if (last && now - last < DONE_DEDUPE_MS) return;
        doneFiredAt.set(sessionId, now);
        void fireBrowserNotification(
          {
            kind: 'done',
            title: localeText('browserDoneTitle'),
            body: snippet || '',
            sessionId,
          },
          cfg,
        );
      };

      const reportError = (sessionId, snippet) => {
        const cfg = configNow();
        if (!cfg.browserNotify || cfg.browserError === false) return;
        void fireBrowserNotification(
          {
            kind: 'error',
            title: localeText('browserErrorTitle'),
            body: snippet || '',
            sessionId,
          },
          cfg,
        );
      };

      // ── 待处理交互（attention）────────────────────────────────
      let listStore = null;
      let uiStore = null;
      let uiSource = null;

      const evalUiStatus = () => {
        const found = uiStore ? { store: uiStore, source: uiSource } : null;
        if (!found || typeof found.store.getSnapshot !== 'function') return;
        let snap;
        try {
          snap = found.store.getSnapshot();
        } catch {
          return;
        }
        if (!snap || typeof snap.forEach !== 'function') return;
        const cfg = configNow();
        const cur = currentSessionIdOf(listStore);
        const seen = new Set();
        snap.forEach((value, sid) => {
          const it = pendingOf(value, found.source);
          if (!it) return;
          if (isSubagentSession(listStore, sid, cur, cfg.browserIgnoreSubagent !== false)) return;
          seen.add(sid);
          const key = it.key || `${it.kind}:${sid}`;
          if (attentionFired.has(key)) return;
          attentionFired.set(key, sid);
          const detail = interactionDetail(it);
          fireAttention(it.kind, sid, detail);
        });
        // 会话的等待消失后，允许下一次等待（新 key）再次提醒。
        for (const [key, keySid] of [...attentionFired]) {
          if (!seen.has(keySid)) attentionFired.delete(key);
        }
      };

      const bindUiSession = () => {
        const svc = lookupService(ctx, 'uiSession');
        const found = interactionStore(svc);
        if (!found) return;
        if (uiStore === found.store) return;
        uiStore = found.store;
        uiSource = found.source;
        try {
          unsub.push(found.store.subscribe(() => {
            try {
              evalUiStatus();
            } catch {
              /* ignore */
            }
          }));
        } catch {
          /* ignore */
        }
        evalUiStatus();
      };

      // ── 完成 / 出错（done / error）────────────────────────────
      // 会话列表行的 running 由 true→false 且非 pending，视为一次回合结束。
      // 但列表行**没有**失败字段（SessionSummary 只有 running 等），所以
      // 「结束」之后是完成还是出错，要看宿主下发的 outcomes（turn/end reason）。
      const prevRunning = new Map();
      const evalList = () => {
        if (!listStore) return;
        let st;
        try {
          st = listStore.getSnapshot();
        } catch {
          return;
        }
        const byId = (st && st.byId) || {};
        const cfg = configNow();
        for (const sid of Object.keys(byId)) {
          const row = byId[sid];
          if (!row) continue;
          const runningNow = !!row.running;
          const wasRunning = prevRunning.get(sid);
          prevRunning.set(sid, runningNow);
          // 只在「之前在跑、现在停了」的边沿提醒；跳过首轮基线。
          if (wasRunning !== true || runningNow) continue;
          if (row.pendingInteraction) continue;
          if (isSubagentSession(listStore, sid, currentSessionIdOf(listStore), cfg.browserIgnoreSubagent !== false)) continue;
          const label = row.displayTitle || row.title || '';
          // 宿主权威结局优先；拿不到（页面刚连上、或 outcome 已过期）时按完成处理，
          // 但不再读根本不存在的 row.failed / row.error。
          if (outcomeKindOf(sid) === 'error') reportError(sid, label);
          else reportDone(sid, label);
        }
      };

      // 绑定会话列表（done/error 的触发源）。
      const sessionsSvc = lookupService(ctx, 'sessions');
      if (sessionsSvc && isStore(sessionsSvc.list)) {
        listStore = sessionsSvc.list;
        try {
          unsub.push(sessionsSvc.list.subscribe(() => {
            try {
              evalList();
            } catch {
              /* ignore */
            }
          }));
        } catch {
          /* ignore */
        }
      }

      bindUiSession();
      evalList();

      // 服务可能延迟就绪，空闲时周期性重绑。
      const retry = setInterval(() => {
        if (disposed) return;
        try {
          if (!listStore) {
            const svc = lookupService(ctx, 'sessions');
            if (svc && isStore(svc.list)) {
              listStore = svc.list;
              unsub.push(svc.list.subscribe(() => {
                try {
                  evalList();
                } catch {
                  /* ignore */
                }
              }));
            }
          }
          bindUiSession();
        } catch {
          /* ignore */
        }
      }, 1500);

      // 结局要跟着宿主走：轮询 /state（只在页面可见时跑，后台标签页不白烧）。
      const refreshState = () => {
        if (disposed || pageHidden()) return;
        void getJson(ROUTES.state).then((data) => {
          if (disposed) return;
          syncOutcomes(data?.outcomes);
          if (data?.config) syncBrowserConfig(data.config);
        }).catch(() => {});
      };
      const outcomeTimer = setInterval(refreshState, 5000);

      // 回到前台立刻刷新一次：隐藏期间轮询是停的，缓存里的结局可能已经是
      // 上一个回合的；等下一次 5s 轮询回来再判，就会把「正常完成」误报成
      // 「本轮出错」。
      const onVisibilityChange = () => {
        if (!pageHidden()) refreshState();
      };
      try {
        document.addEventListener('visibilitychange', onVisibilityChange);
      } catch {
        /* ignore */
      }

      return () => {
        disposed = true;
        clearInterval(retry);
        clearInterval(outcomeTimer);
        try {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        } catch {
          /* ignore */
        }
        for (const fn of unsub) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      };
    }

    /** 从交互对象抽出一行展示文案。 */
    function interactionDetail(it) {
      if (!it || typeof it !== 'object') return '';
      const keys = ['text', 'question', 'prompt', 'title', 'summary', 'description', 'message', 'reason', 'toolName', 'name', 'tool'];
      for (const key of keys) {
        const v = it[key];
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 160);
        if (v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim()) return v.text.trim().slice(0, 160);
      }
      return '';
    }

    // 读取浏览器通知相关配置（从宿主配置页同步下来的状态）。
    // 宿主配置是权威；本地未同步时按默认开启。
    let browserCfgCache = null;
    /**
     * 宿主下发的回合结局：sessionId -> { kind: 'done'|'error'|'other', at }。
     *
     * 页面侧的会话列表行没有失败字段，靠它才能把「刚结束」分类成出错还是完成。
     */
    const outcomeCache = new Map();
    function readBrowserConfig() {
      return browserCfgCache ?? { ...EMPTY };
    }
    function syncBrowserConfig(cfg) {
      browserCfgCache = { ...EMPTY, ...(cfg ?? {}) };
    }
    /**
     * 结局视为「过期」的时长。
     *
     * 页面隐藏时 /state 轮询直接跳过，缓存里可能还留着该会话**上一个回合**的
     * 结局。若不加时限，后台完成的正常回合会被上一条 `error` 判成「本轮出错」。
     * 一分钟足够覆盖前台的轮询抖动，又不会把上一次失败带进下一次完成。
     */
    const OUTCOME_TTL_MS = 60_000;

    /** 取某会话最近一次回合结局（'done' | 'error' | 'other' | ''）；过期视为未知。 */
    function outcomeKindOf(sessionId) {
      const entry = sessionId ? outcomeCache.get(sessionId) : null;
      if (!entry || typeof entry.kind !== 'string') return '';
      const at = Number(entry.at) || 0;
      if (at > 0 && Date.now() - at > OUTCOME_TTL_MS) return '';
      return entry.kind;
    }
    /** 用 /state 的 outcomes 刷新缓存；只保留最近的一批。 */
    function syncOutcomes(list) {
      if (!Array.isArray(list)) return;
      outcomeCache.clear();
      for (const item of list) {
        if (!item || typeof item.sessionId !== 'string') continue;
        outcomeCache.set(item.sessionId, { kind: item.kind, at: Number(item.at) || 0 });
      }
    }

    // 通知文案跟随界面语言（zh / en）。
    function localeText(key) {
      let lang = 'zh';
      try {
        lang = readLocale(currentLocaleCtx) === 'en' ? 'en' : 'zh';
      } catch {
        /* ignore */
      }
      return (DICTS[lang] && DICTS[lang][key]) || DICTS.zh[key] || key;
    }
    let currentLocaleCtx = null;

    function apply(ctx) {
      currentLocaleCtx = ctx;
      injectStyle();
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'webhook-notify: dictionaries');
      const t = ctx.locale.bind(NS);
      const disposers = [];
      disposers.push(
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'webhook-notify',
              order: 46,
              label: () => t('nav'),
              locale: NS,
            },
            function WebhookNotifySettingsSection() {
              useLocaleRevision(ctx);
              return h(Panel, { ctx, t });
            },
          ),
        ),
      );
      ctx.effect(
        () => () => {
          for (const dispose of disposers.reverse()) dispose();
        },
        'webhook-notify: slots',
      );

      // 所有 window 级监听都要有归属：HMR / 插件卸载时逐个摘掉，
      // 否则重载一次就多一套监听，通知会成倍弹出。
      const windowCleanups = [];
      const onWindow = (type, handler, options) => {
        try {
          window.addEventListener(type, handler, options);
          windowCleanups.push(() => window.removeEventListener(type, handler, options));
        } catch {
          /* ignore */
        }
      };

      // 浏览器通知：初始化运行时 + 注册 Service Worker + 启动事件监听。
      try {
        if (typeof window !== 'undefined') {
          notifier = createNotifier({
            notify: window.Notification,
            serviceWorker: navigator?.serviceWorker,
            BroadcastChannel: window.BroadcastChannel,
            onNavigate: (info) => {
              try {
                // 两处都判：worker 里的通知按发送时的偏好决定，页面这里按
                // 当前（可能已更新的）偏好兜底，旧缓存通知也守得住这个开关。
                if (info?.autoFocus === false) return;
                if (readBrowserConfig().browserAutoFocus === false) return;
                if (info?.navigate !== false) focusSession(info?.sessionId ?? null);
              } catch {
                /* ignore */
              }
            },
            onResubscribe: () => {
              void resubscribePush();
            },
            getIcon: () => `${window.location?.origin ?? ''}/favicon.svg`,
          });
          const activeNotifier = notifier;
          ctx.effect(() => () => activeNotifier.dispose(), 'webhook-notify: notifier');
          // 首次交互后申请权限 + 解锁（浏览器要求用户手势）。
          const unlock = () => {
            try {
              void activeNotifier.requestPermission();
            } catch {
              /* ignore */
            }
            removeUnlock();
          };
          const removeUnlock = () => {
            try {
              window.removeEventListener('pointerdown', unlock, true);
              window.removeEventListener('keydown', unlock, true);
            } catch {
              /* ignore */
            }
          };
          onWindow('pointerdown', unlock, true);
          onWindow('keydown', unlock, true);
          ctx.effect(() => removeUnlock, 'webhook-notify: unlock');
          activeNotifier.ensureBridge(ROUTES.sw);
          // 配置从宿主拉一次，之后设置页保存时同步。
          getJson(ROUTES.state).then((data) => {
            if (data?.config) syncBrowserConfig(data.config);
            syncOutcomes(data?.outcomes);
          }).catch(() => {});
          ctx.effect(() => startBrowserWatchers(ctx), 'webhook-notify: browser-watchers');
        }
      } catch (error) {
        try {
          console.error('[webhook-notify] browser notifications unavailable', error);
        } catch {
          /* ignore */
        }
      }

      // ── Web Push 状态 ────────────────────────────────────────────
      try {
        if (typeof window !== 'undefined') {
          // 拉一次推送状态，订阅数量才能显示出来。
          void readPushStatus();
        }
      } catch (error) {
        try {
          console.error('[webhook-notify] Web Push features unavailable', error);
        } catch {
          /* ignore */
        }
      }

      ctx.effect(() => () => {
        for (const fn of windowCleanups.splice(0)) {
          try {
            fn();
          } catch {
            /* ignore */
          }
        }
      }, 'webhook-notify: window-listeners');
    }

    return { inject: ['slots', 'locale'], apply, name: 'webhook-notify-client' };
  },
});
