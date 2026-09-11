/**
 * AtomCode 嵌入式 Dock（第三方站点外嵌版）
 *
 * 零依赖单文件，第三方站点通过 <script src="https://atomgit.com/embed/atomcode-dock.js"> 引入即用：
 * - 渲染左下角（或正文容器左下侧）悬浮输入区，Shadow DOM 隔离宿主样式；
 * - 用户点击发送后，按 prompt 协议组装内容并跳转 AtomGit 完成对话；
 * - 始终展示输入框，无关闭/收起入口；重复引用只产生一个实例。
 *
 * 接入配置（可选，脚本加载前设置）：
 *   window.AtomCodeDockConfig = {
 *     containerSelector: 'article',  // 显式指定正文容器选择器（最高优先级）
 *     zIndex: 2147483000             // 悬浮层级（默认极高值）
 *   }
 *
 * 本文件运行在任意第三方页面，不得引用仓库内任何模块或构建产物。
 */
;(function () {
  'use strict'

  /** 单例守卫：重复引用只产生一个实例（非浏览器环境无 window，跳过） */
  if (typeof window !== 'undefined' && window.__ATOMCODE_EMBED_DOCK__) return
  if (typeof window !== 'undefined') window.__ATOMCODE_EMBED_DOCK__ = true

  /** 跳转目标页（协议固定，prompt/isLogin 由发送逻辑追加） */
  var TARGET_URL = 'https://atomgit.com/dashboard'

  /** 默认配置（可被 window.AtomCodeDockConfig 覆盖的字段） */
  var DEFAULT_CONFIG = {
    /** 接入方显式指定的正文容器选择器（最高优先级，空串表示自动识别） */
    containerSelector: '',
    /** 悬浮层 z-index */
    zIndex: 2147483000
  }

  /** 最终生效配置 */
  var CONFIG = assign({}, DEFAULT_CONFIG, readUserConfig())

  /** 读取接入方配置（非法类型时忽略；非浏览器环境无 window，返回空） */
  function readUserConfig() {
    if (typeof window === 'undefined') return {}
    var raw = window.AtomCodeDockConfig
    return raw && typeof raw === 'object' ? raw : {}
  }

  /** 浅合并对象（后者覆盖前者，跳过 undefined） */
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i]
      if (!src || typeof src !== 'object') continue
      for (var key in src) {
        if (Object.prototype.hasOwnProperty.call(src, key) && src[key] !== undefined) {
          target[key] = src[key]
        }
      }
    }
    return target
  }

  /* ------------------------------------------------------------------ */
  /* 站点专用适配                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 站点专用正文容器适配表：按 hostname 匹配后返回该站点的正文选择器。
   * 优先级介于接入方显式配置与通用 main/article 识别之间。
   */
  var SITE_ADAPTERS = [
    {
      // 华为开发者空间（CSDN 托管）：文章详情页正文容器为 .article-detail；
      // 页面为整页滚动（无内部滚动容器），跟随锚点由容器可见底部驱动
      test: /huaweicloud\.csdn\.net$/,
      containerSelector: '.article-detail'
    }
  ]

  /**
   * 按优先级解析正文容器：
   * 接入方显式选择器 → 站点专用适配 → 通用 main/article/[role=main] → null（视口兜底）。
   * 候选元素不可见（无布局尺寸）时跳过继续降级。
   */
  function resolveContainer() {
    var candidates = []
    if (CONFIG.containerSelector) candidates.push(CONFIG.containerSelector)
    for (var i = 0; i < SITE_ADAPTERS.length; i++) {
      if (SITE_ADAPTERS[i].test.test(window.location.hostname)) {
        candidates.push(SITE_ADAPTERS[i].containerSelector)
      }
    }
    candidates.push('main', 'article', '[role="main"]')
    for (var j = 0; j < candidates.length; j++) {
      var el = document.querySelector(candidates[j])
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) return el
    }
    return null
  }

  /* ------------------------------------------------------------------ */
  /* Shadow DOM 挂载与界面                                                */
  /* ------------------------------------------------------------------ */

  /** 悬浮层宿主元素（fixed 定位由 JS 计算） */
  var host = null
  /** Shadow root */
  var shadow = null
  /** 面板元素（Shadow Root 内的 .ac-dock 根节点；定位/zIndex 统一使用此引用，
   *  不能用 host.firstElementChild——元素挂在 Shadow Root 里而非 host 直接子节点） */
  var panel = null
  /** 输入框元素 */
  var textarea = null
  /** 发送按钮元素 */
  var sendBtn = null
  /** 中文输入法选词进行中标记：选词期间 Enter 不触发发送 */
  var composing = false

  /** 面板样式（注入 Shadow DOM，不污染宿主页面） */
  var DOCK_CSS = [
    ':host { all: initial; }',
    '.ac-dock {',
    '  position: fixed; left: 16px; top: 100vh; /* 初始位置由 JS 计算 */',
    '  width: 340px; max-width: calc(100vw - 24px);',
    '  box-sizing: border-box; padding: 10px 12px 12px;',
    '  background: #ffffff; border: 1px solid #e3e3ee; border-radius: 12px;',
    '  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.14);',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",',
    '    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;',
    '  color: #24292f;',
    '}',
    '@media (max-width: 480px) {',
    '  .ac-dock { width: calc(100vw - 24px); }',
    '}',
    '.ac-brand {',
    '  display: flex; align-items: center; gap: 6px;',
    '  margin-bottom: 8px; font-size: 12px; font-weight: 600; color: #57606a;',
    '  user-select: none;',
    '}',
    '.ac-logo {',
    '  width: 16px; height: 16px; border-radius: 4px; flex: none;',
    '  background: linear-gradient(135deg, #3b82f6, #8b5cf6);',
    '}',
    '.ac-textarea {',
    '  display: block; width: 100%; box-sizing: border-box;',
    '  height: 64px; resize: none; padding: 8px 10px;',
    '  border: 1px solid #d0d7de; border-radius: 8px;',
    '  font: inherit; font-size: 13px; line-height: 1.5; color: #24292f;',
    '  background: #ffffff; outline: none;',
    '}',
    '.ac-textarea::placeholder { color: #8c959f; }',
    '.ac-textarea:focus { border-color: #3b82f6; }',
    '.ac-footer { display: flex; justify-content: flex-end; margin-top: 8px; }',
    '.ac-send {',
    '  display: inline-flex; align-items: center; gap: 4px;',
    '  padding: 5px 14px; border: none; border-radius: 7px; cursor: pointer;',
    '  background: #3b82f6; color: #ffffff; font: inherit; font-size: 13px; font-weight: 500;',
    '}',
    '.ac-send:hover { background: #2f6fe0; }',
    '.ac-send svg { width: 14px; height: 14px; fill: currentColor; }'
  ].join('\n')

  /** 发送按钮内的纸飞机图标（内联 SVG，零外部资源） */
  var SEND_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M.989 8 .066 2.716a.5.5 0 0 1 .727-.528l13.999 7.284a.5.5 0 0 1 0 .885L.793 17.84a.5.5 0 0 1-.727-.528L.99 9.75l7.004-1.75L.989 8Z" transform="scale(0.94)"/></svg>'

  /**
   * 挂载 Shadow DOM 并构建界面：品牌行 + 文本输入框 + 发送按钮。
   * 输入框始终展示，无关闭/收起入口。
   */
  function mount() {
    host = document.createElement('div')
    host.setAttribute('data-atomcode-embed-dock', '')
    shadow = host.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = DOCK_CSS
    shadow.appendChild(style)

    var root = document.createElement('div')
    root.className = 'ac-dock'
    panel = root

    var brand = document.createElement('div')
    brand.className = 'ac-brand'
    var logo = document.createElement('span')
    logo.className = 'ac-logo'
    brand.appendChild(logo)
    brand.appendChild(document.createTextNode('AtomCode'))

    textarea = document.createElement('textarea')
    textarea.className = 'ac-textarea'
    textarea.rows = 3
    textarea.placeholder = '向 AtomCode 提问，或直接发送阅读本页…'
    textarea.setAttribute('aria-label', 'AtomCode 输入框')

    var footer = document.createElement('div')
    footer.className = 'ac-footer'
    sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'ac-send'
    sendBtn.innerHTML = SEND_ICON + '<span>发送</span>'
    sendBtn.setAttribute('aria-label', '发送到 AtomCode')
    footer.appendChild(sendBtn)

    root.appendChild(brand)
    root.appendChild(textarea)
    root.appendChild(footer)
    shadow.appendChild(root)

    document.body.appendChild(host)
  }

  /* ------------------------------------------------------------------ */
  /* 定位：固定悬浮 + 正文区域跟随                                         */
  /* ------------------------------------------------------------------ */

  /** 待处理的位置重算请求是否已排队（requestAnimationFrame 合并更新） */
  var positionScheduled = false
  /** 当前正文容器（滚动/尺寸变化监听目标；容器变化时重建监听） */
  var currentContainer = null
  /** 正文容器滚动监听（{ el, handle }）与 ResizeObserver */
  var containerScrollBinding = null
  var containerResizeObserver = null

  /**
   * 计算并应用悬浮层位置。
   * 方案：position: fixed 本身不随正文滚动，因此以「正文容器可见区域左下角」
   * 为锚点实时计算 fixed 坐标——取容器 border-box 与视口交集的左下角，
   * 再约束在视口内；无容器时回退视口左下角。
   */
  function updatePosition() {
    positionScheduled = false
    if (!panel) return
    var dock = panel
    if (!dock) return

    var margin = 16
    var vw = window.innerWidth
    var vh = window.innerHeight

    // 重新解析容器（页面路由变化 / 容器显隐时自适应），变化时重建监听
    var container = resolveContainer()
    if (container !== currentContainer) {
      bindContainer(container)
    }

    var dockWidth = dock.offsetWidth || 340
    var dockHeight = dock.offsetHeight || 120

    // 水平锚点：容器可见区左边（无容器时贴视口左侧）
    var left = margin
    if (currentContainer) {
      var rect = currentContainer.getBoundingClientRect()
      left = Math.max(rect.left, 0) + margin
    }
    left = Math.min(Math.max(left, margin), Math.max(margin, vw - dockWidth - margin))

    // 垂直锚点：容器与视口交集的可见底部（滚出视口的部分不计入）；
    // 无容器或容器滚出视口时回退视口底部。dock 底边贴锚点。
    var anchorBottom = vh - margin
    if (currentContainer) {
      var visibleBottom = Math.min(currentContainer.getBoundingClientRect().bottom, vh)
      if (visibleBottom > 0) anchorBottom = visibleBottom - margin
    }
    // 约束在视口内：顶边不小于 margin，底边不超过视口底
    var top = Math.min(Math.max(anchorBottom - dockHeight, margin), vh - margin)

    dock.style.left = left + 'px'
    dock.style.top = top + 'px'
  }

  /** 请求一次位置重算（rAF 合并同一帧内的多次触发） */
  function schedulePositionUpdate() {
    if (positionScheduled) return
    positionScheduled = true
    window.requestAnimationFrame(updatePosition)
  }

  /**
   * 绑定正文容器的滚动与尺寸变化监听；容器为 null 时解绑旧监听。
   * 同时兼容整页滚动（window scroll）与内部滚动容器（el scroll + ResizeObserver）。
   */
  function bindContainer(container) {
    // 解绑旧容器
    if (containerScrollBinding) {
      containerScrollBinding.el.removeEventListener('scroll', schedulePositionUpdate)
      containerScrollBinding = null
    }
    if (containerResizeObserver) {
      containerResizeObserver.disconnect()
      containerResizeObserver = null
    }
    currentContainer = container
    if (!container) return

    // 内部滚动容器：scroll 事件重算位置
    container.addEventListener('scroll', schedulePositionUpdate, { passive: true })
    containerScrollBinding = { el: container, handle: schedulePositionUpdate }

    // 容器内容/尺寸变化：ResizeObserver 响应正文高度增减（如图片加载、展开评论）
    if (typeof window.ResizeObserver === 'function') {
      containerResizeObserver = new window.ResizeObserver(schedulePositionUpdate)
      containerResizeObserver.observe(container)
    }
  }

  /* ------------------------------------------------------------------ */
  /* prompt 组装与跳转                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 按 prompt 协议组装跳转内容：
   * - 空内容或纯空白：`帮我阅读这篇内容：{当前网页地址}`
   * - 有内容：`{用户输入内容}，链接：{当前网页地址}`
   * 地址默认取 window.location.href（浏览器端即「点击发送瞬间的最新地址」，
   * 保留查询参数与锚点）；currentHref 参数供测试注入。
   */
  function buildPrompt(userInput, currentHref) {
    var href = currentHref != null ? currentHref : window.location.href
    var text = String(userInput == null ? '' : userInput).replace(/^\s+|\s+$/g, '')
    if (!text) return '帮我阅读这篇内容：' + href
    return text + '，链接：' + href
  }

  /**
   * 组装完整跳转地址（当前标签页跳转由调用方执行）。使用 URL + URLSearchParams
   * 保证中文、换行、&、# 等字符编码正确；目标地址固定携带 isLogin=1 与 prompt。
   */
  function buildJumpUrl(userInput, currentHref) {
    var base = currentHref != null ? currentHref : window.location.href
    var target = new URL(TARGET_URL, base)
    target.searchParams.set('isLogin', '1')
    target.searchParams.set('prompt', buildPrompt(userInput, currentHref))
    return target.href
  }

  /** 发送：空输入也允许发送（发送阅读请求）；当前标签页跳转 */
  function handleSend() {
    if (!textarea) return
    window.location.href = buildJumpUrl(textarea.value)
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                                */
  /* ------------------------------------------------------------------ */

  /** 绑定全局监听（整页滚动 / 窗口缩放 / 文档结构变化）并完成挂载 */
  function start() {
    if (!document.body) {
      // body 尚未就绪（脚本在 <head> 中同步加载）：DOM 就绪后重试
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      } else {
        setTimeout(start, 0)
      }
      return
    }
    if (host) return

    mount()

    // 悬浮层级（panel 是 Shadow Root 内的面板元素，fixed 样式挂在它身上）
    if (panel && CONFIG.zIndex) panel.style.zIndex = String(CONFIG.zIndex)

    // 事件：Enter 发送 / Shift+Enter 换行；中文输入法选词期间不触发发送
    textarea.addEventListener('compositionstart', function () {
      composing = true
    })
    textarea.addEventListener('compositionend', function () {
      composing = false
    })
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !composing) {
        e.preventDefault()
        handleSend()
      }
    })
    sendBtn.addEventListener('click', handleSend)

    // 整页滚动与窗口变化（fixed 元素不随滚动移动，需实时重算）
    window.addEventListener('scroll', schedulePositionUpdate, { passive: true })
    window.addEventListener('resize', schedulePositionUpdate)
    // 挂载后首帧：等 dock 尺寸渲染完成再定位
    schedulePositionUpdate()
  }

  // Node / 单测环境：仅导出纯逻辑（prompt 组装、跳转地址构建），不执行任何浏览器副作用
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildPrompt: buildPrompt, buildJumpUrl: buildJumpUrl }
    return
  }

  start()
})()
