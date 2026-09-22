/**
 * @name 爱听音乐
 * @description 爱听音乐音源，支持22a5站内搜索与LRC歌词解析
 * @version 1.3.0
 * @author 爱听音乐
 * @homepage https://www.22a5.com
 */

// 洛雪音源：仅可用 ES6+ 与 lx 提供的 API
// v1.3.0 修复：移除 POST 手动 Content-Type，避免移动端跳过 form 转 body 导致请求体为空
// v1.2.0 优化：启动预热 / 无cookie直达 / 搜索与播放链接缓存 / 解析限流
const { EVENT_NAMES, request, on, send } = globalThis['lx']
const lxUtils = globalThis['lx'] && globalThis['lx'].utils

const HOST = 'https://www.22a5.com'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const TIMEOUT = 8000
const SEARCH_TTL = 10 * 60 * 1000 // 搜索结果缓存 10 分钟
const PLAY_TTL = 10 * 60 * 1000   // 播放链接缓存 10 分钟
const MAX_ITEMS = 40              // 搜索解析上限

// 音质声明：爱听站不区分音质，仅作兼容
const qualitys = {
  kg: { '128k': '128k', '320k': '320k', flac: 'flac' },
  tx: { '128k': '128k', '320k': '320k', flac: 'flac' },
  wy: { '128k': '128k', '320k': '320k', flac: 'flac' },
  kw: { '128k': '128k', '320k': '320k', flac: 'flac' },
  mg: { '128k': '128k', '320k': '320k', flac: 'flac' },
}

// 安全日志
function log() {
  try { console.log.apply(console, arguments) } catch (e) { /* ignore */ }
}

// 自维护 cookie
var cookieStr = ''
function saveSetCookies(setCookieVal) {
  if (!setCookieVal) return
  var list = Array.isArray(setCookieVal) ? setCookieVal : [setCookieVal]
  for (var i = 0; i < list.length; i++) {
    var segs = String(list[i]).split(';')
    for (var j = 0; j < segs.length; j++) {
      var seg = segs[j].trim()
      if (!seg) continue
      var eq = seg.indexOf('=')
      if (eq <= 0) continue
      var key = seg.substring(0, eq).trim()
      if (/^(path|domain|expires|max-age|samesite|secure|httponly)$/i.test(key)) continue
      var val = seg.substring(eq + 1).split(',')[0].trim()
      var re = new RegExp('(^|;\\s*)' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=[^;]*')
      var pair = key + '=' + val
      if (re.test(cookieStr)) cookieStr = cookieStr.replace(re, '$1' + pair)
      else cookieStr = cookieStr ? cookieStr + '; ' + pair : pair
      break
    }
  }
}
// 兼容两种 headers 结构：普通对象 / Headers 实例
function getHeader(resp, name) {
  if (!resp || !resp.headers) return null
  try {
    if (typeof resp.headers.get === 'function') {
      var v = resp.headers.get(name)
      if (v != null) return v
    }
  } catch (e) { /* ignore */ }
  var v = resp.headers[name] || resp.headers[name.toLowerCase()] || resp.headers[name.toUpperCase()]
  return v == null ? null : v
}

// 响应体转字符串
function bodyToText(body) {
  if (body == null) return ''
  if (typeof body === 'string') return body
  if (typeof body === 'object') {
    var isBin = false
    try {
      if (body.constructor && (body.constructor.name === 'Buffer' || body.constructor.name === 'Uint8Array')) isBin = true
      if (body.byteLength !== undefined || (body.buffer instanceof ArrayBuffer)) isBin = true
    } catch (e) { /* ignore */ }
    if (isBin) {
      try {
        if (lxUtils && lxUtils.buffer && lxUtils.buffer.bufToString) {
          return lxUtils.buffer.bufToString(body, 'utf8')
        }
      } catch (e) { /* ignore */ }
      try {
        var view = new Uint8Array(body.buffer ? body.buffer : body)
        var out = ''
        for (var i = 0; i < view.length; i++) out += String.fromCharCode(view[i])
        return utf8Decode(out)
      } catch (e) { /* ignore */ }
      try { return body.toString('utf8') } catch (e) { /* ignore */ }
      return ''
    }
    if (body.url !== undefined) return body.url || ''
    try { return JSON.stringify(body) } catch (e) { /* ignore */ }
  }
  try { return String(body) } catch (e) { /* ignore */ }
  return ''
}

// 简单 UTF-8 解码
function utf8Decode(bin) {
  var out = ''
  var i = 0
  while (i < bin.length) {
    var c = bin.charCodeAt(i)
    if (c < 0x80) { out += String.fromCharCode(c); i++ }
    else if (c < 0xe0) { out += String.fromCharCode(((c & 0x1f) << 6) | (bin.charCodeAt(i + 1) & 0x3f)); i += 2 }
    else if (c < 0xf0) {
      out += String.fromCharCode(((c & 0x0f) << 12) | ((bin.charCodeAt(i + 1) & 0x3f) << 6) | (bin.charCodeAt(i + 2) & 0x3f)); i += 3
    } else {
      var cp = ((c & 0x07) << 18) | ((bin.charCodeAt(i + 1) & 0x3f) << 12) | ((bin.charCodeAt(i + 2) & 0x3f) << 6) | (bin.charCodeAt(i + 3) & 0x3f)
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    }
  }
  return out
}

// HTTP 封装：回调对齐洛雪两参数 (err, resp)，resp.body 为响应体
function httpRequest(url, options) {
  options = options || {}
  var headers = Object.assign({ 'User-Agent': UA }, options.headers || {})
  if (cookieStr) headers['Cookie'] = cookieStr
  var opts = Object.assign({}, options, { headers: headers })
  if (opts.timeout == null) opts.timeout = TIMEOUT
  return new Promise((resolve, reject) => {
    try {
      request(url, opts, function (err, resp, body) {
        if (err) return reject(err)
        try {
          var sc = getHeader(resp, 'set-cookie')
          if (sc) saveSetCookies(sc)
        } catch (e) { /* ignore */ }
        var b = resp && resp.body !== undefined ? resp.body : (body !== undefined ? body : '')
        resolve({ status: resp && resp.statusCode, body: bodyToText(b) })
      })
    } catch (e) { reject(e) }
  })
}

// 拼接绝对地址
function abs(url) {
  if (!url) return ''
  if (/^https?:/i.test(url)) return url
  return HOST + (url.charAt(0) === '/' ? '' : '/') + url
}

// 过滤 LRC 歌词中的广告
function filterLrcAds(lrcText) {
  if (!lrcText) return ''
  var lines = lrcText.split(/\r?\n/)
  var filtered = []
  var adPatterns = [
    /欢迎来访.*/i, /本站.*/i, /.*广告.*/i, /QQ群.*/i, /.*www\..*/i, /.*http.*/i,
    /.*\.com.*/i, /.*\.cn.*/i, /.*\.net.*/i, /.*音乐网.*/i, /.*提供.*/i, /.*下载.*/i,
  ]
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^\[\d{2}:\d{2}/.test(line)) {
      var isAd = false
      for (var j = 0; j < adPatterns.length; j++) {
        if (adPatterns[j].test(line)) { isAd = true; break }
      }
      if (!isAd) filtered.push(line)
    } else {
      filtered.push(line)
    }
  }
  return filtered.join('\n')
}

function isVerifyPage(html) {
  return typeof html === 'string' && html.indexOf('verifyForm') !== -1
}

// 解析搜索结果页（限流）
function parseSearchItems(html) {
  var items = []
  var liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
  var m
  while ((m = liRe.exec(html)) !== null) {
    if (items.length >= MAX_ITEMS) break
    var block = m[1]
    var hrefM = /<a[^>]+href=["'](\/(?:song|mp3|radio|radiolist|radioplay)\/([^"']+\.html))["'][^>]*>/i.exec(block)
    if (!hrefM) continue
    var href = hrefM[1]
    var hrefTail = hrefM[2]
    if (/^(?:index|top|new|hot|oumei|huayu|hanguo|ribrn|male|girl|band|liuxing|dianzi|yaogun|xiha|rb|minyao|jueshi|gudian)\.html$/.test(hrefTail)) continue
    var name = ''
    var nameM = /class=["']name["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (nameM) name = nameM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()
    if (!name) {
      var titleM = /<a[^>]+title=["']([^"']*)["']/i.exec(block)
      if (titleM) name = titleM[1].trim()
    }
    if (!name) continue
    if (/^(首页|新歌榜|TOP榜单|DJ舞曲|歌手|歌单|电台|高清MV|主播电台|原创歌手|音乐歌单)$/.test(name)) continue
    items.push({ id: href, name: name })
  }
  return items
}

// 完成站点人机验证
function verifyHuman() {
  return httpRequest(HOST + '/', { method: 'GET' }).then(function (res) {
    var html = res.body
    var tokenM = /name=["']csrf_token["'][^>]*value=["']([^"']*)["']/i.exec(html)
    var token = tokenM ? tokenM[1] : ''
    if (!token) return Promise.resolve()
    return httpRequest(HOST + '/', {
      method: 'POST',
      headers: { 'Referer': HOST + '/' },
      form: { csrf_token: token, human_check: 'on' },
    }).then(function () { return Promise.resolve() })
  })
}

// 带验证的页面请求（无 cookie 时先验证，省一次无效请求）
function getPageWithVerify(url) {
  if (!cookieStr) {
    return verifyHuman().then(function () {
      return httpRequest(url, { method: 'GET' })
    }).then(function (res) { return res.body })
  }
  return httpRequest(url, { method: 'GET' }).then(function (res) {
    if (isVerifyPage(res.body)) {
      return verifyHuman().then(function () {
        return httpRequest(url, { method: 'GET' })
      }).then(function (res2) { return res2.body })
    }
    return res.body
  })
}

// 缓存工具
var searchCache = {}
var playCache = {}
function cacheGet(cache, key) {
  var e = cache[key]
  if (e && Date.now() - e.t < e.ttl) return e.v
  return null
}
function cacheSet(cache, key, val, ttl) {
  cache[key] = { t: Date.now(), ttl: ttl, v: val }
}

// 站内搜索（带缓存）
function searchSongs(keyword) {
  var hit = cacheGet(searchCache, keyword)
  if (hit) return Promise.resolve(hit)
  var url = HOST + '/so/' + encodeURIComponent(keyword) + '/1.html'
  return getPageWithVerify(url).then(function (html) {
    var items = parseSearchItems(html)
    cacheSet(searchCache, keyword, items, SEARCH_TTL)
    return items
  })
}

// 通过歌曲页链接解析真实播放地址（带缓存）
function resolvePlayUrl(songUrl) {
  var midM = /\/(?:song|mp3|radio|radiolist|radioplay)\/([^/]+)\.html/.exec(abs(songUrl))
  if (!midM) return Promise.reject(new Error('无法识别的歌曲链接'))
  var mid = midM[1]
  var hit = cacheGet(playCache, mid)
  if (hit) return Promise.resolve(hit)
  return httpRequest(HOST + '/js/play.php', {
    method: 'POST',
    headers: {
      'Referer': abs(songUrl),
      'X-Requested-With': 'XMLHttpRequest',
    },
    form: { id: mid, type: 'music' },
  }).then(function (res) {
    var text = res.body
    var url = ''
    if (/^https?:\/\//i.test(text.trim())) url = text.trim()
    else {
      try {
        var json = JSON.parse(text)
        if (json.url) url = json.url.replace(/\\\//g, '/')
      } catch (e) { /* not json */ }
    }
    if (!url) return Promise.reject(new Error('播放解析失败'))
    cacheSet(playCache, mid, url, PLAY_TTL)
    return url
  })
}

// 获取 LRC 歌词
function fetchLyric(songUrl) {
  var midM = /\/(?:song|mp3|radio|radiolist|radioplay)\/([^/]+)\.html/.exec(abs(songUrl))
  if (!midM) return Promise.reject(new Error('无法识别的歌曲链接'))
  var mid = midM[1]
  var lrcUrl = HOST + '/plug/down.php?ac=music&lk=lrc&id=' + encodeURIComponent(mid)
  return httpRequest(lrcUrl, { method: 'GET' })
    .then(function (res) { return filterLrcAds(res.body) })
}

// 构造搜索关键词
function buildKeyword(musicInfo) {
  var name = (musicInfo && (musicInfo.name || musicInfo.songName)) || ''
  var singer = musicInfo && (musicInfo.singer || musicInfo.singerName || musicInfo.artist || '')
  if (singer && typeof singer !== 'string') {
    try { singer = Array.isArray(singer) ? singer.join(' ') : String(singer) } catch (e) { singer = '' }
  }
  singer = singer || ''
  if (singer) return name + ' ' + singer
  return name
}

// 搜索并匹配最佳结果
function matchSong(musicInfo) {
  var name = ((musicInfo && (musicInfo.name || musicInfo.songName)) || '').replace(/\s+/g, '')
  var singer = buildKeyword(musicInfo).replace(/\s+/g, '')
  var kw = buildKeyword(musicInfo) || '歌曲'
  return searchSongs(kw).then(function (items) {
    if (!items.length) return Promise.reject(new Error('22a5站内未找到歌曲'))
    if (name && singer) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].name.indexOf(name) !== -1 && items[i].name.indexOf(singer) !== -1) return items[i]
      }
    }
    if (name) {
      for (var j = 0; j < items.length; j++) {
        if (items[j].name.indexOf(name) !== -1) return items[j]
      }
    }
    return items[0]
  })
}

// 歌词缓存：洛极发 lyric 请求时 musicInfo 无站内链接，需用 musicUrl 阶段的结果
var lyricCache = {}
function lyricKey(musicInfo) {
  var mi = musicInfo || {}
  return String(mi.hash || mi.songmid || mi.id || (mi.name + (mi.singer || ''))) || ''
}

// 各平台源 API
const apis = {}
;['kg', 'tx', 'wy', 'kw', 'mg'].forEach((src) => {
  apis[src] = {
    musicUrl(musicInfo, quality) {
      return matchSong(musicInfo).then(function (song) {
        var k = lyricKey(musicInfo)
        if (k) lyricCache[k] = song.id
        return resolvePlayUrl(song.id)
      })
    },
    lyric(musicInfo) {
      var k = lyricKey(musicInfo)
      var songUrl = k && lyricCache[k]
      if (!songUrl) return Promise.resolve({ lyric: '', tlyric: '' })
      return fetchLyric(songUrl)
        .then(function (lrc) { return { lyric: lrc, tlyric: '' } })
        .catch(function () { return { lyric: '', tlyric: '' } })
    },
  }
})

// 注册应用 API 请求事件
on(EVENT_NAMES.request, ({ source, action, info }) => {
  var api = apis[source]
  if (!api) return Promise.reject('不支持的音乐源: ' + source)
  switch (action) {
    case 'musicUrl':
      if (!info || !info.musicInfo || !info.type) return Promise.reject('参数不完整')
      return api.musicUrl(info.musicInfo, qualitys[source][info.type]).catch((err) => {
        log('[爱听音乐] musicUrl 失败:', err && err.message)
        return Promise.reject(err)
      })
    case 'lyric':
      if (!info || !info.musicInfo) return Promise.reject('参数不完整')
      return api.lyric(info.musicInfo)
    default:
      return Promise.reject('action not support: ' + action)
  }
})

// 初始化完成
send(EVENT_NAMES.inited, {
  status: true,
  sources: {
    kg: { name: '爱听音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    tx: { name: '爱听音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    wy: { name: '爱听音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    kw: { name: '爱听音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    mg: { name: '爱听音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
  },
})

// 后台预热：提前完成人机验证，缩短首次播放等待
try {
  verifyHuman().catch(function (e) { log('[爱听音乐] 预热失败:', e && e.message) })
} catch (e) { /* ignore */ }