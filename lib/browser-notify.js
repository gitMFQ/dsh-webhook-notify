/**
 * 浏览器通知客户端（页面半边）。
 *
 * 参考 dsh-notify-me 的做法：持久通知走 Service Worker（页面挂起后仍能弹、
 * 点击能带回用户手势），没有 worker 时退回页面内 `new Notification()`。
 * 触发逻辑（哪条事件该不该弹、当前会话静默、子代理静默）留在 client.js，
 * 本文件只负责“把一条通知弹出去并处理点击”。
 *
 * 这是纯 ES 模块，宿主测试直接 import；页面侧由 lib/client.js 内联同一套
 * 逻辑（浏览器 bundle 不打包本文件，避免 require 逃逸到加载器表外）。
 * 两处的公开行为必须一致：show / requestPermission / dispose / bridgeState。
 */

/** 客户端与 worker 之间的消息通道名（与 lib/sw.js 保持一致）。 */
export const BRIDGE_CHANNEL = 'dsh-webhook-notify:bridge';

/** 通知 tag 前缀。 */
export const NOTIFICATION_TAG_PREFIX = 'dsh-webhook-notify-';

/** 页面通知的自动关闭时间（毫秒）。 */
const PAGE_NOTIFICATION_TTL = 15_000;

/**
 * 创建通知管理器。
 *
 * @param options.notify 全局 Notification 构造器（可注入以便测试）。
 * @param options.serviceWorker navigator.serviceWorker（可注入）。
 * @param options.BroadcastChannel 全局 BroadcastChannel 构造器（可注入）。
 * @param options.onNavigate 点击通知后的回调：(info: {sessionId, kind, navigate, autoFocus}) => void。
 * @param options.onResubscribe 订阅失效（浏览器轮换了订阅）时的回调。
 * @param options.getTag 生成通知 tag：(kind, key) => string。
 * @param options.getIcon 生成图标 URL：() => string | undefined。
 * @param options.bridgeTimeoutMs 等待 worker 就绪的最长时间（默认 2000）。
 */
export function createNotifier(options = {}) {
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
  let bridgeState = 'idle'; // idle | registering | active | unsupported:* | failed:*
  let bridgeListening = false;
  let permissionPending = null;
  let disposed = false;
  /** 注册尚未落地的 Promise：show 可以短暂等它，避免「启动期必走页面通知」。 */
  let bridgePending = null;
  /** 当前页弹出的通知实例（dispose 时统一关闭）。 */
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

  /**
   * 请求通知权限（必须在用户手势上下文里调用才一定弹出询问）。
   *
   * 返回 Promise<'granted'|'denied'|'default'|'unsupported'>。失败可重试：
   * 之前用一个永久的 permissionAsked 标记，一次失败后就再也问不到了。
   */
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

  // worker 回来的点击消息：BroadcastChannel（同源所有页面）+ client.postMessage。
  // 只挂一种监听：同时挂 addEventListener 和 onmessage 会让同一条消息
  // 触发两次导航。
  const handleBridgeMessage = (message) => {
    if (disposed) return;
    if (!message || message.source !== 'dsh-webhook-notify') return;
    // 订阅被浏览器轮换：通知调用方重新订阅并上报宿主。
    if (message.type === 'pushsubscriptionchange') {
      try {
        onResubscribe();
      } catch {
        /* 回调异常不影响后续处理 */
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

  /** 注册 Service Worker；失败降级为页面内通知，不算错误。 */
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
      bridgePending = pending.then((reg) => {
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
      }, (error) => {
        if (!disposed) bridgeState = `failed: ${error?.message || error}`;
        return null;
      });
      return bridgePending;
    } catch (error) {
      bridgeState = `failed: ${error?.message || error}`;
      return undefined;
    }
  };

  /** 等 worker 就绪一小段时间；超时就按当前状态继续（通常是降级页面通知）。 */
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

  /** 页面内通知（worker 不可用时的降级路径）。 */
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
      // 页面通知会被浏览器自动收起，这里给一个明确的上限。
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

  /**
   * 弹一条通知。
   *
   * @param payload {kind, key, title, body, sessionId, silent, autoFocus, onClick}
   * @returns {Promise<'sw'|'page'|'skipped'>}
   */
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
    // 注册还在路上时稍等一下：否则启动期的第一条通知永远走页面降级。
    if (bridgeState === 'registering') await awaitBridge();
    if (registration && typeof registration.showNotification === 'function') {
      try {
        // autoFocus 随通知落到 worker：点击在 worker 里处理，那里读不到页面
        // 配置，不带上的话「点击通知回到对应对话」的开关在常态路径下无效。
        const options = { body, tag, renotify: true, silent, data: { sessionId, kind, autoFocus } };
        if (icon) options.icon = icon;
        // showNotification 返回 Promise：不 await/catch 的话，一次拒绝就是
        // 一条 unhandledRejection，而调用方还以为通知发出去了。
        await registration.showNotification(title, options);
        return 'sw';
      } catch {
        /* worker 通知不可用 → 页面通知 */
      }
    }
    return showPageNotification({ kind, body, sessionId, silent, autoFocus, onClick }, title, tag, icon);
  };

  /** 关闭某个 tag 的已弹通知（等待被处理后清理用）。 */
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

  /** 释放所有监听与页面通知；可重复调用。 */
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
