/**
 * @name 布谷音乐
 * @description 布谷音乐音源（buguyy.top），支持站内搜索、播放与LRC歌词
 * @version 1.0.0
 * @author 布谷音乐
 * @homepage https://www.buguyy.top
 */

// 洛雪音源：仅可用 ES6+ 与 lx 提供的 API
// 接口说明：
//   搜索  GET /api/search?keyword=xxx -> { success, data:[{id,title,singer,picurl,about}] }  id 为 base64
//   播放  GET /api/geturl?id=<base64id> -> { success, url }
//   歌词  来自搜索结果的 about 字段（[秒.xx]时间轴格式 -> 转标准LRC）
const { EVENT_NAMES, request, on, send } = globalThis['lx']
const lxUtils = globalThis['lx'] && globalThis['lx'].utils

const HOST = 'https://www.buguyy.top'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const TIMEOUT = 8000
const SEARCH_TTL = 10 * 60 * 1000
const PLAY_TTL = 10 * 60 * 1000

// 安全日志
function log() {
  try { console.log.apply(console, arguments) } catch (e) { /* ignore */ }
}

// 响应体转字符串：兼容移动端(Buffer/对象)与桌面端(字符串)
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
        if (lxUtils && lxUtils.buffer && lxUtils.buffer.bufToString) return lxUtils.buffer.bufToString(body, 'utf8')
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
    if (body.url !== undefined && typeof body.url === 'string' && body.success === undefined) return body.url || ''
    try { return JSON.stringify(body) } catch (e) { /* ignore */ }
  }
  try { return String(body) } catch (e) { /* ignore */ }
  return ''
}

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

// HTTP GET 封装
function httpGet(url) {
  return new Promise((resolve, reject) => {
    try {
      request(url, { method: 'GET', headers: { 'User-Agent': UA }, timeout: TIMEOUT }, function (err, resp, body) {
        if (err) return reject(err)
        var b = resp && resp.body !== undefined ? resp.body : (body !== undefined ? body : '')
        resolve(bodyToText(b))
      })
    } catch (e) { reject(e) }
  })
}

// JSON 解析
function toJson(text) {
  if (text == null) return null
  var t = String(text).trim()
  if (!t) return null
  try { return JSON.parse(t) } catch (e) { return null }
}

// API 请求
function apiGet(path) {
  return httpGet(HOST + path).then(function (text) {
    var json = toJson(text)
    if (!json || json.success !== true) return Promise.reject(new Error('布谷接口异常'))
    return json
  })
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

// 站内搜索
function searchSongs(keyword) {
  var hit = cacheGet(searchCache, keyword)
  if (hit) return Promise.resolve(hit)
  return apiGet('/api/search?keyword=' + encodeURIComponent(keyword)).then(function (json) {
    var items = []
    if (json.data) {
      for (var i = 0; i < json.data.length; i++) {
        var x = json.data[i]
        if (!x || !x.id) continue
        items.push({
          id: String(x.id),
          name: String(x.title || ''),
          artist: String(x.singer || ''),
          about: x.about || '',
        })
      }
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

// 搜索并匹配
function matchSong(musicInfo) {
  var rawName = (musicInfo && (musicInfo.name || musicInfo.songName)) || ''
  var name = rawName.replace(/\s+/g, '')
  var singer = buildKeyword(musicInfo).replace(/\s+/g, '')
  var kw = buildKeyword(musicInfo) || '歌曲'
  return searchSongs(kw).then(function (items) {
    if (!items.length && rawName) return searchSongs(rawName)
    return items
  }).then(function (items) {
    if (!items.length) return Promise.reject(new Error('布谷站内未找到歌曲'))
    if (name && singer) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].name.indexOf(name) !== -1 && items[i].artist.indexOf(singer) !== -1) return items[i]
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

// 解析播放地址
function resolvePlayUrl(songId) {
  var hit = cacheGet(playCache, songId)
  if (hit) return Promise.resolve(hit)
  return apiGet('/api/geturl?id=' + encodeURIComponent(songId)).then(function (json) {
    if (!json.url) return Promise.reject(new Error('布谷播放解析失败'))
    var url = String(json.url).replace(/\\\//g, '/')
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('布谷播放链接无效'))
    cacheSet(playCache, songId, url, PLAY_TTL)
    return url
  })
}

// about 字段转标准 LRC（[秒.xx] 格式 -> [mm:ss.xx]）
function aboutToLrc(about) {
  if (!about) return ''
  var text = String(about).replace(/<br\s*\/?\s*>/gi, '\n')
  var lines = text.split(/\r?\n/)
  var out = []
  var hasTime = false
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    var m = line.match(/^\[(\d+(?:\.\d+)?)\]\s*(.*)/)
    if (m) {
      hasTime = true
      out.push('[' + fmtSec(m[1]) + ']' + m[2])
    }
  }
  return hasTime ? out.join('\n') : ''
}

function fmtSec(secStr) {
  var sec = parseFloat(secStr)
  if (isNaN(sec)) return '00:00.00'
  var m = Math.floor(sec / 60)
  var s = sec - m * 60
  var mm = m < 10 ? '0' + m : String(m)
  var ss = s.toFixed(2)
  if (s < 10) ss = '0' + ss
  return mm + ':' + ss
}

// 获取 LRC 歌词（来自搜索结果 about）
function fetchLyric(about) {
  return Promise.resolve(aboutToLrc(about))
}

// 歌词缓存：musicUrl 阶段记录歌曲，lyric 阶段用
var songCache = {}
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
        if (k) songCache[k] = song
        return resolvePlayUrl(song.id)
      })
    },
    lyric(musicInfo) {
      var k = lyricKey(musicInfo)
      var song = k && songCache[k]
      if (!song) return Promise.resolve({ lyric: '', tlyric: '' })
      return fetchLyric(song.about)
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
        log('[布谷音乐] musicUrl 失败:', err && err.message)
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
    kg: { name: '布谷音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    tx: { name: '布谷音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    wy: { name: '布谷音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    kw: { name: '布谷音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
    mg: { name: '布谷音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: ['128k', '320k', 'flac'] },
  },
})