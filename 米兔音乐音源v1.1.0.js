/**
 * @name 米兔音乐
 * @description 米兔音乐音源（qqmp3.vip），支持站内搜索、播放与LRC歌词
 * @version 1.1.0
 * @author 米兔音乐
 * @homepage https://www.qqmp3.vip
 */

// 洛雪音源：仅可用 ES6+ 与 lx 提供的 API
// v1.1.0 增强：搜索无结果降级纯歌名重搜、播放解析多音质自动降级重试
// 接口说明：
//   搜索  GET /api/songs.php?type=search&keyword=xxx -> { code, data:[{rid,name,artist,pic}] }
//   播放  GET /api/kw.php?rid=xx&type=json&level=standard|high|exhigh|lossless&lrc=0 -> { data:{url} }
//   歌词  GET /api/kw.php?rid=xx&type=json&level=exhigh&lrc=1 -> { data:{lrc} }
// 注意：所有请求必须带 Referer: https://www.qqmp3.vip/ ，否则 403
const { EVENT_NAMES, request, on, send } = globalThis['lx']
const lxUtils = globalThis['lx'] && globalThis['lx'].utils

const HOST = 'https://www.qqmp3.vip'
const REFERER = HOST + '/'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const TIMEOUT = 8000
const SEARCH_TTL = 10 * 60 * 1000
const PLAY_TTL = 10 * 60 * 1000
const LYRIC_TTL = 10 * 60 * 1000

// 音质映射：米兔用酷我 level 参数
const LEVEL_MAP = { '128k': 'standard', '320k': 'exhigh', flac: 'lossless' }
const QUALITYS = ['128k', '320k', 'flac']
// 降级顺序（从高到低尝试）
const LEVEL_ORDER = ['lossless', 'exhigh', 'high', 'standard']

// 安全日志
function log() {
  try { console.log.apply(console, arguments) } catch (e) { /* ignore */ }
}

// 响应体转 JSON：兼容移动端(已自动parse/对象)与桌面端(字符串)
function toJson(body) {
  if (body == null) return null
  if (typeof body === 'string') {
    var t = body.trim()
    if (!t) return null
    try { return JSON.parse(t) } catch (e) { return null }
  }
  if (typeof body === 'object') {
    var isBin = false
    try {
      if (body.constructor && (body.constructor.name === 'Buffer' || body.constructor.name === 'Uint8Array')) isBin = true
      if (body.byteLength !== undefined || (body.buffer instanceof ArrayBuffer)) isBin = true
    } catch (e) { /* ignore */ }
    if (isBin) {
      try {
        var text = ''
        if (lxUtils && lxUtils.buffer && lxUtils.buffer.bufToString) text = lxUtils.buffer.bufToString(body, 'utf8')
        else text = body.toString ? String(body) : ''
        if (text) { try { return JSON.parse(text) } catch (e) { return null } }
      } catch (e) { /* ignore */ }
      return null
    }
    return body
  }
  return null
}

// HTTP GET 封装（回调对齐洛雪两参数/三参数）
function httpGet(url) {
  return new Promise((resolve, reject) => {
    try {
      request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Referer': REFERER },
        timeout: TIMEOUT,
      }, function (err, resp, body) {
        if (err) return reject(err)
        var b = resp && resp.body !== undefined ? resp.body : (body !== undefined ? body : '')
        resolve(toJson(b))
      })
    } catch (e) { reject(e) }
  })
}

// API 请求
function apiGet(path) {
  return httpGet(HOST + path)
}

// 缓存工具
var searchCache = {}
var playCache = {}
var lyricCache = {}
function cacheGet(cache, key) {
  var e = cache[key]
  if (e && Date.now() - e.t < e.ttl) return e.v
  return null
}
function cacheSet(cache, key, val, ttl) {
  cache[key] = { t: Date.now(), ttl: ttl, v: val }
}

// 过滤歌词广告
function filterLrcAds(lrcText) {
  if (!lrcText) return ''
  var lines = String(lrcText).split(/\r?\n/)
  var out = []
  var ads = [/qqmp3/i, /米兔音乐/i, /www\..*/i, /http.*/i, /本歌词由/i, /酷狗音乐/i, /下载.*APP/i]
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^\[\d{2}:\d{2}/.test(line)) {
      var isAd = false
      for (var j = 0; j < ads.length; j++) {
        if (ads[j].test(line)) { isAd = true; break }
      }
      if (!isAd) out.push(line)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

// 站内搜索（带缓存）
function searchSongs(keyword) {
  var hit = cacheGet(searchCache, keyword)
  if (hit) return Promise.resolve(hit)
  return apiGet('/api/songs.php?type=search&keyword=' + encodeURIComponent(keyword)).then(function (json) {
    if (!json || json.code !== 200 || !json.data) return Promise.resolve([])
    var items = []
    for (var i = 0; i < json.data.length; i++) {
      var x = json.data[i]
      if (!x || !x.rid) continue
      items.push({ rid: String(x.rid), name: String(x.name || ''), artist: String(x.artist || '') })
    }
    cacheSet(searchCache, keyword, items, SEARCH_TTL)
    return items
  })
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

// 从搜索结果中挑选最佳匹配
function pickBest(items, name, singer) {
  var n = String(name || '').replace(/\s+/g, '')
  var s = String(singer || '').replace(/\s+/g, '')
  if (n && s) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].name.indexOf(n) !== -1 && items[i].artist.indexOf(s) !== -1) return items[i]
    }
  }
  if (n) {
    for (var j = 0; j < items.length; j++) {
      if (items[j].name.indexOf(n) !== -1) return items[j]
    }
  }
  return items[0]
}

// 搜索并匹配最佳结果（带降级：歌手+歌名 -> 纯歌名）
function matchSong(musicInfo) {
  var name = ((musicInfo && (musicInfo.name || musicInfo.songName)) || '').replace(/\s+/g, '')
  var singer = buildKeyword(musicInfo).replace(/\s+/g, '')
  var kw = buildKeyword(musicInfo) || '歌曲'
  return searchSongs(kw).then(function (items) {
    if (!items.length && name) return searchSongs(name)
    return items
  }).then(function (items) {
    if (!items.length) return Promise.reject(new Error('米兔站内未找到歌曲'))
    return pickBest(items, name, singer)
  })
}

// 解析播放地址（多音质自动降级 + 重试）
function resolvePlayUrl(rid, quality) {
  var prefer = LEVEL_MAP[quality] || 'exhigh'
  // 构造尝试顺序：首选音质在前，其余按 LEVEL_ORDER 降级
  var order = []
  var seen = {}
  function push(lv) {
    if (lv && !seen[lv]) { seen[lv] = true; order.push(lv) }
  }
  push(prefer)
  for (var i = 0; i < LEVEL_ORDER.length; i++) push(LEVEL_ORDER[i])
  // 附加 fallback 音质（酷我完整列表）
  push('jymaster'); push('flac24bit'); push('hires')

  function tryOne(idx, attempt) {
    if (idx >= order.length) return Promise.reject(new Error('播放解析失败'))
    var level = order[idx]
    var key = rid + '|' + level
    var hit = cacheGet(playCache, key)
    if (hit) return Promise.resolve(hit)
    return apiGet('/api/kw.php?rid=' + encodeURIComponent(rid) + '&type=json&level=' + level + '&lrc=0').then(function (json) {
      if (json && json.code === 200 && json.data && json.data.url) {
        var url = String(json.data.url).replace(/\\\//g, '/')
        if (/^https?:\/\//i.test(url)) {
          cacheSet(playCache, key, url, PLAY_TTL)
          return url
        }
      }
      return tryOne(idx + 1)
    }).catch(function () {
      return tryOne(idx + 1)
    })
  }
  return tryOne(0)
}

// 获取 LRC 歌词
function fetchLyric(rid) {
  var hit = cacheGet(lyricCache, rid)
  if (hit) return Promise.resolve(hit)
  return apiGet('/api/kw.php?rid=' + encodeURIComponent(rid) + '&type=json&level=exhigh&lrc=1').then(function (json) {
    var lrc = (json && json.data && json.data.lrc) ? String(json.data.lrc) : ''
    lrc = filterLrcAds(lrc)
    cacheSet(lyricCache, rid, lrc, LYRIC_TTL)
    return lrc
  })
}

// 歌词 rid 缓存：洛雪发 lyric 请求时 musicInfo 无站内 rid，用 musicUrl 阶段的结果
var ridCache = {}
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
        if (k) ridCache[k] = song.rid
        return resolvePlayUrl(song.rid, quality)
      })
    },
    lyric(musicInfo) {
      var k = lyricKey(musicInfo)
      var rid = k && ridCache[k]
      if (!rid) return Promise.resolve({ lyric: '', tlyric: '' })
      return fetchLyric(rid)
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
      return api.musicUrl(info.musicInfo, info.type).catch((err) => {
        log('[米兔音乐] musicUrl 失败:', err && err.message)
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
    kg: { name: '米兔音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS },
    tx: { name: '米兔音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS },
    wy: { name: '米兔音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS },
    kw: { name: '米兔音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS },
    mg: { name: '米兔音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS },
  },
})