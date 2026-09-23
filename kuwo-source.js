/**
 * @name 酷我音乐
 * @description 酷我音乐音源（kuwo.cn），支持站内搜索匹配、多音质播放（含无损）与LRC歌词
 * @version 1.0.0
 * @author kuwo.cn
 * @homepage https://www.kuwo.cn
 */

// 洛雪音源（仅依赖 lx 提供的 API，无任何外部依赖；桌面端/移动端兼容）
// v1.0.0 接口实现：
//   搜索  GET http://www.kuwo.cn/search/searchMusicBykeyWord?...&all=关键词&rformat=json&mobi=1 -> { abslist }
//         备选 GET http://search.kuwo.cn/r.s?all=关键词&ft=music... -> 伪JSON（单引号）
//   播放  GET http://mobi.kuwo.cn/mobi.s?f=kuwo&q=<DES(ylzsxkwm)加密的query串>
//         query: user=0&corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1
//                &type=convert_url2&sig=0&format=mp3|flac[&br=320kmp3]&rid=歌曲ID
//         128k -> format=mp3；320k -> format=mp3&br=320kmp3；flac -> format=flac
//   歌词  GET http://newlyric.kuwo.cn/newlyric.lrc?<XOR(yeelion)加密的params串>
//         params: user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_歌曲ID
//         响应为 zlib 压缩的 gb2312 歌词文本：内置纯JS解压(deflate)与GBK解码表
//         （DES/XOR参考开源实现 musicdl / kwplayer / UnblockNeteaseMusic，感谢！）
const { EVENT_NAMES, request, on, send } = globalThis['lx']
const lxUtils = globalThis['lx'] && globalThis['lx'].utils

// ==== 配置 ====
var TIMEOUT = 10000
var SEARCH_TTL = 10 * 60 * 1000
var PLAY_TTL = 10 * 60 * 1000
var LYRIC_TTL = 10 * 60 * 1000
var QUALITYS = ['128k', '320k', 'flac']
var UA_WEB = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
var UA_APP = 'okhttp/3.10.0'

// 安全日志
function log() {
  try { console.log.apply(console, arguments) } catch (e) { /* ignore */ }
}

// ==== 缓存 ====
var searchCache = {}
var playCache = {}
var lyricCache = {}
var ridCache = {}
function cacheGet(cache, key) {
  try {
    var e = cache[key]
    if (e && Date.now() - e.t < e.ttl) return e.v
  } catch (e) { /* ignore */ }
  return null
}
function cacheSet(cache, key, val, ttl) {
  try { cache[key] = { t: Date.now(), ttl: ttl, v: val } } catch (e) { /* ignore */ }
}

// ==== 基础工具 ====
// 响应体转文本：兼容移动端(自动parse的对象/二进制)与桌面端(字符串)
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
        if (body.toString) return String(body)
      } catch (e) { /* ignore */ }
      return ''
    }
    try { return JSON.stringify(body) } catch (e) { return String(body) }
  }
  return String(body)
}

function toJson(body) {
  var text = bodyToText(body)
  if (!text) return null
  var t = text.trim()
  if (!t) return null
  try { return JSON.parse(t) } catch (e) { return null }
}

// base64 编解码（沙箱安全实现，不依赖 atob/btoa）
var B64_TAB = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function bytesToBase64(bytes) {
  var out = []
  var i = 0
  for (; i + 2 < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out.push(B64_TAB[(n >> 18) & 63]); out.push(B64_TAB[(n >> 12) & 63]); out.push(B64_TAB[(n >> 6) & 63]); out.push(B64_TAB[n & 63])
  }
  var rem = bytes.length - i
  if (rem === 1) {
    var n1 = bytes[i] << 16
    out.push(B64_TAB[(n1 >> 18) & 63]); out.push(B64_TAB[(n1 >> 12) & 63]); out.push('='); out.push('=')
  } else if (rem === 2) {
    var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out.push(B64_TAB[(n2 >> 18) & 63]); out.push(B64_TAB[(n2 >> 12) & 63]); out.push(B64_TAB[(n2 >> 6) & 63]); out.push('=')
  }
  return out.join('')
}
function base64ToBytes(b64) {
  var s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '')
  var out = []
  var i = 0
  while (i < s.length) {
    var c0 = B64_TAB.indexOf(s.charAt(i++))
    var c1 = i < s.length ? B64_TAB.indexOf(s.charAt(i++)) : -1
    var c2 = i < s.length ? B64_TAB.indexOf(s.charAt(i++)) : -1
    var c3 = i < s.length ? B64_TAB.indexOf(s.charAt(i++)) : -1
    if (c0 < 0 || c1 < 0) break
    out.push((c0 << 2) | ((c1 & 48) >> 4))
    if (c2 >= 0) out.push(((c1 & 15) << 4) | ((c2 & 60) >> 2))
    else break
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3)
  }
  return new Uint8Array(out)
}

function strToBytes(s) {
  s = String(s || '')
  var out = new Uint8Array(s.length)
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

// XOR 加解密（对称）
function xorCrypt(bytes, keyStr) {
  var key = strToBytes(keyStr)
  var out = new Uint8Array(bytes.length)
  for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length]
  return out
}

// ==== GBK(GB2312) 解码表：lead 0xA1-0xFE × trail 0xA1-0xFE 共 94×94 ====
var GBK_TABLE = '　、。·ˉˇ¨〃々—～‖…‘’“”〔〕〈〉《》「」『』〖〗【】±×÷∶∧∨∑∏∪∩∈∷√⊥∥∠⌒⊙∫∮≡≌≈∽∝≠≮≯≤≥∞∵∴♂♀°′″℃＄¤￠￡‰§№☆★○●◎◇◆□■△▲※→←↑↓〓ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇①②③④⑤⑥⑦⑧⑨⑩€㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ！＂＃￥％＆＇（）＊＋，－．／０１２３４５６７８９：；＜＝＞？＠ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ［＼］＾＿｀ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ｛｜｝￣ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω︐︒︑︓︔︕︖︵︶︹︺︿﹀︽︾﹁﹂﹃﹄︗︘︻︼︷︸︱︙︳︴АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüêɑḿńňǹɡㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦㄧㄨㄩ─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆榜膀绑棒磅蚌镑傍谤苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳病并玻菠播拨钵波博勃搏铂箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤昌猖场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮怠耽担丹单郸掸胆旦氮但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟蝶迭谍叠丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给根跟耕更庚羹埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲荆兢茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵觉决诀绝均菌钧军君峻俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫馏留刘瘤流柳六龙聋咙笼窿隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫谩芒茫盲氓忙莽猫茅锚毛矛铆卯茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿鸟尿捏聂孽啮镊镍涅您柠狞凝宁拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺哦欧鸥殴藕呕偶沤啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬篇偏片骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃普浦谱曝瀑期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣讫掐恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀裙群然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱撒洒萨腮鳃塞赛三叁伞散桑嗓丧搔骚扫嫂瑟色涩森僧莎砂杀刹沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生甥牲升绳省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所塌他它她塔獭挞蹋踏胎苔抬台泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳贴铁帖厅听烃汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下厦夏吓掀锨先仙鲜纤咸贤衔舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄削哮嚣销消宵淆晓小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续轩喧宣悬旋玄选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡殉汛训讯逊迅压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶摇尧遥窑谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音阴姻吟银淫寅饮尹引隐印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉浴寓裕预豫驭鸳渊冤元垣袁原援辕园员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕匝砸杂栽哉灾宰载再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎曾赠扎喳渣札轧铡闸眨栅榨咋乍炸诈摘斋宅窄债寨瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇阵蒸挣睁征狰争怔整拯正政帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻抓爪拽专砖转撰赚篆桩庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座亍丌兀丐廿卅丕亘丞鬲孬噩丨禺丿匕乇夭爻卮氐囟胤馗毓睾鼗丶亟鼐乜乩亓芈孛啬嘏仄厍厝厣厥厮靥赝匚叵匦匮匾赜卦卣刂刈刎刭刳刿剀剌剞剡剜蒯剽劂劁劐劓冂罔亻仃仉仂仨仡仫仞伛仳伢佤仵伥伧伉伫佞佧攸佚佝佟佗伲伽佶佴侑侉侃侏佾佻侪佼侬侔俦俨俪俅俚俣俜俑俟俸倩偌俳倬倏倮倭俾倜倌倥倨偾偃偕偈偎偬偻傥傧傩傺僖儆僭僬僦僮儇儋仝氽佘佥俎龠汆籴兮巽黉馘冁夔勹匍訇匐凫夙兕亠兖亳衮袤亵脔裒禀嬴蠃羸冫冱冽冼凇冖冢冥讠讦讧讪讴讵讷诂诃诋诏诎诒诓诔诖诘诙诜诟诠诤诨诩诮诰诳诶诹诼诿谀谂谄谇谌谏谑谒谔谕谖谙谛谘谝谟谠谡谥谧谪谫谮谯谲谳谵谶卩卺阝阢阡阱阪阽阼陂陉陔陟陧陬陲陴隈隍隗隰邗邛邝邙邬邡邴邳邶邺邸邰郏郅邾郐郄郇郓郦郢郜郗郛郫郯郾鄄鄢鄞鄣鄱鄯鄹酃酆刍奂劢劬劭劾哿勐勖勰叟燮矍廴凵凼鬯厶弁畚巯坌垩垡塾墼壅壑圩圬圪圳圹圮圯坜圻坂坩垅坫垆坼坻坨坭坶坳垭垤垌垲埏垧垴垓垠埕埘埚埙埒垸埴埯埸埤埝堋堍埽埭堀堞堙塄堠塥塬墁墉墚墀馨鼙懿艹艽艿芏芊芨芄芎芑芗芙芫芸芾芰苈苊苣芘芷芮苋苌苁芩芴芡芪芟苄苎芤苡茉苷苤茏茇苜苴苒苘茌苻苓茑茚茆茔茕苠苕茜荑荛荜茈莒茼茴茱莛荞茯荏荇荃荟荀茗荠茭茺茳荦荥荨茛荩荬荪荭荮莰荸莳莴莠莪莓莜莅荼莶莩荽莸荻莘莞莨莺莼菁萁菥菘堇萘萋菝菽菖萜萸萑萆菔菟萏萃菸菹菪菅菀萦菰菡葜葑葚葙葳蒇蒈葺蒉葸萼葆葩葶蒌蒎萱葭蓁蓍蓐蓦蒽蓓蓊蒿蒺蓠蒡蒹蒴蒗蓥蓣蔌甍蔸蓰蔹蔟蔺蕖蔻蓿蓼蕙蕈蕨蕤蕞蕺瞢蕃蕲蕻薤薨薇薏蕹薮薜薅薹薷薰藓藁藜藿蘧蘅蘩蘖蘼廾弈夼奁耷奕奚奘匏尢尥尬尴扌扪抟抻拊拚拗拮挢拶挹捋捃掭揶捱捺掎掴捭掬掊捩掮掼揲揸揠揿揄揞揎摒揆掾摅摁搋搛搠搌搦搡摞撄摭撖摺撷撸撙撺擀擐擗擤擢攉攥攮弋忒甙弑卟叱叽叩叨叻吒吖吆呋呒呓呔呖呃吡呗呙吣吲咂咔呷呱呤咚咛咄呶呦咝哐咭哂咴哒咧咦哓哔呲咣哕咻咿哌哙哚哜咩咪咤哝哏哞唛哧唠哽唔哳唢唣唏唑唧唪啧喏喵啉啭啁啕唿啐唼唷啖啵啶啷唳唰啜喋嗒喃喱喹喈喁喟啾嗖喑啻嗟喽喾喔喙嗪嗷嗉嘟嗑嗫嗬嗔嗦嗝嗄嗯嗥嗲嗳嗌嗍嗨嗵嗤辔嘞嘈嘌嘁嘤嘣嗾嘀嘧嘭噘嘹噗嘬噍噢噙噜噌噔嚆噤噱噫噻噼嚅嚓嚯囔囗囝囡囵囫囹囿圄圊圉圜帏帙帔帑帱帻帼帷幄幔幛幞幡岌屺岍岐岖岈岘岙岑岚岜岵岢岽岬岫岱岣峁岷峄峒峤峋峥崂崃崧崦崮崤崞崆崛嵘崾崴崽嵬嵛嵯嵝嵫嵋嵊嵩嵴嶂嶙嶝豳嶷巅彳彷徂徇徉後徕徙徜徨徭徵徼衢彡犭犰犴犷犸狃狁狎狍狒狨狯狩狲狴狷猁狳猃狺狻猗猓猡猊猞猝猕猢猹猥猬猸猱獐獍獗獠獬獯獾舛夥飧夤夂饣饧饨饩饪饫饬饴饷饽馀馄馇馊馍馐馑馓馔馕庀庑庋庖庥庠庹庵庾庳赓廒廑廛廨廪膺忄忉忖忏怃忮怄忡忤忾怅怆忪忭忸怙怵怦怛怏怍怩怫怊怿怡恸恹恻恺恂恪恽悖悚悭悝悃悒悌悛惬悻悱惝惘惆惚悴愠愦愕愣惴愀愎愫慊慵憬憔憧憷懔懵忝隳闩闫闱闳闵闶闼闾阃阄阆阈阊阋阌阍阏阒阕阖阗阙阚丬爿戕氵汔汜汊沣沅沐沔沌汨汩汴汶沆沩泐泔沭泷泸泱泗沲泠泖泺泫泮沱泓泯泾洹洧洌浃浈洇洄洙洎洫浍洮洵洚浏浒浔洳涑浯涞涠浞涓涔浜浠浼浣渚淇淅淞渎涿淠渑淦淝淙渖涫渌涮渫湮湎湫溲湟溆湓湔渲渥湄滟溱溘滠漭滢溥溧溽溻溷滗溴滏溏滂溟潢潆潇漤漕滹漯漶潋潴漪漉漩澉澍澌潸潲潼潺濑濉澧澹澶濂濡濮濞濠濯瀚瀣瀛瀹瀵灏灞宀宄宕宓宥宸甯骞搴寤寮褰寰蹇謇辶迓迕迥迮迤迩迦迳迨逅逄逋逦逑逍逖逡逵逶逭逯遄遑遒遐遨遘遢遛暹遴遽邂邈邃邋彐彗彖彘尻咫屐屙孱屣屦羼弪弩弭艴弼鬻屮妁妃妍妩妪妣妗姊妫妞妤姒妲妯姗妾娅娆姝娈姣姘姹娌娉娲娴娑娣娓婀婧婊婕娼婢婵胬媪媛婷婺媾嫫媲嫒嫔媸嫠嫣嫱嫖嫦嫘嫜嬉嬗嬖嬲嬷孀尕尜孚孥孳孑孓孢驵驷驸驺驿驽骀骁骅骈骊骐骒骓骖骘骛骜骝骟骠骢骣骥骧纟纡纣纥纨纩纭纰纾绀绁绂绉绋绌绐绔绗绛绠绡绨绫绮绯绱绲缍绶绺绻绾缁缂缃缇缈缋缌缏缑缒缗缙缜缛缟缡缢缣缤缥缦缧缪缫缬缭缯缰缱缲缳缵幺畿巛甾邕玎玑玮玢玟珏珂珑玷玳珀珉珈珥珙顼琊珩珧珞玺珲琏琪瑛琦琥琨琰琮琬琛琚瑁瑜瑗瑕瑙瑷瑭瑾璜璎璀璁璇璋璞璨璩璐璧瓒璺韪韫韬杌杓杞杈杩枥枇杪杳枘枧杵枨枞枭枋杷杼柰栉柘栊柩枰栌柙枵柚枳柝栀柃枸柢栎柁柽栲栳桠桡桎桢桄桤梃栝桕桦桁桧桀栾桊桉栩梵梏桴桷梓桫棂楮棼椟椠棹椤棰椋椁楗棣椐楱椹楠楂楝榄楫榀榘楸椴槌榇榈槎榉楦楣楹榛榧榻榫榭槔榱槁槊槟榕槠榍槿樯槭樗樘橥槲橄樾檠橐橛樵檎橹樽樨橘橼檑檐檩檗檫猷獒殁殂殇殄殒殓殍殚殛殡殪轫轭轱轲轳轵轶轸轷轹轺轼轾辁辂辄辇辋辍辎辏辘辚軎戋戗戛戟戢戡戥戤戬臧瓯瓴瓿甏甑甓攴旮旯旰昊昙杲昃昕昀炅曷昝昴昱昶昵耆晟晔晁晏晖晡晗晷暄暌暧暝暾曛曜曦曩贲贳贶贻贽赀赅赆赈赉赇赍赕赙觇觊觋觌觎觏觐觑牮犟牝牦牯牾牿犄犋犍犏犒挈挲掰搿擘耄毪毳毽毵毹氅氇氆氍氕氘氙氚氡氩氤氪氲攵敕敫牍牒牖爰虢刖肟肜肓肼朊肽肱肫肭肴肷胧胨胩胪胛胂胄胙胍胗朐胝胫胱胴胭脍脎胲胼朕脒豚脶脞脬脘脲腈腌腓腴腙腚腱腠腩腼腽腭腧塍媵膈膂膑滕膣膪臌朦臊膻臁膦欤欷欹歃歆歙飑飒飓飕飙飚殳彀毂觳斐齑斓於旆旄旃旌旎旒旖炀炜炖炝炻烀炷炫炱烨烊焐焓焖焯焱煳煜煨煅煲煊煸煺熘熳熵熨熠燠燔燧燹爝爨灬焘煦熹戾戽扃扈扉礻祀祆祉祛祜祓祚祢祗祠祯祧祺禅禊禚禧禳忑忐怼恝恚恧恁恙恣悫愆愍慝憩憝懋懑戆肀聿沓泶淼矶矸砀砉砗砘砑斫砭砜砝砹砺砻砟砼砥砬砣砩硎硭硖硗砦硐硇硌硪碛碓碚碇碜碡碣碲碹碥磔磙磉磬磲礅磴礓礤礞礴龛黹黻黼盱眄眍盹眇眈眚眢眙眭眦眵眸睐睑睇睃睚睨睢睥睿瞍睽瞀瞌瞑瞟瞠瞰瞵瞽町畀畎畋畈畛畲畹疃罘罡罟詈罨罴罱罹羁罾盍盥蠲钅钆钇钋钊钌钍钏钐钔钗钕钚钛钜钣钤钫钪钭钬钯钰钲钴钶钷钸钹钺钼钽钿铄铈铉铊铋铌铍铎铐铑铒铕铖铗铙铘铛铞铟铠铢铤铥铧铨铪铩铫铮铯铳铴铵铷铹铼铽铿锃锂锆锇锉锊锍锎锏锒锓锔锕锖锘锛锝锞锟锢锪锫锩锬锱锲锴锶锷锸锼锾锿镂锵镄镅镆镉镌镎镏镒镓镔镖镗镘镙镛镞镟镝镡镢镤镥镦镧镨镩镪镫镬镯镱镲镳锺矧矬雉秕秭秣秫稆嵇稃稂稞稔稹稷穑黏馥穰皈皎皓皙皤瓞瓠甬鸠鸢鸨鸩鸪鸫鸬鸲鸱鸶鸸鸷鸹鸺鸾鹁鹂鹄鹆鹇鹈鹉鹋鹌鹎鹑鹕鹗鹚鹛鹜鹞鹣鹦鹧鹨鹩鹪鹫鹬鹱鹭鹳疒疔疖疠疝疬疣疳疴疸痄疱疰痃痂痖痍痣痨痦痤痫痧瘃痱痼痿瘐瘀瘅瘌瘗瘊瘥瘘瘕瘙瘛瘼瘢瘠癀瘭瘰瘿瘵癃瘾瘳癍癞癔癜癖癫癯翊竦穸穹窀窆窈窕窦窠窬窨窭窳衤衩衲衽衿袂袢裆袷袼裉裢裎裣裥裱褚裼裨裾裰褡褙褓褛褊褴褫褶襁襦襻疋胥皲皴矜耒耔耖耜耠耢耥耦耧耩耨耱耋耵聃聆聍聒聩聱覃顸颀颃颉颌颍颏颔颚颛颞颟颡颢颥颦虍虔虬虮虿虺虼虻蚨蚍蚋蚬蚝蚧蚣蚪蚓蚩蚶蛄蚵蛎蚰蚺蚱蚯蛉蛏蚴蛩蛱蛲蛭蛳蛐蜓蛞蛴蛟蛘蛑蜃蜇蛸蜈蜊蜍蜉蜣蜻蜞蜥蜮蜚蜾蝈蜴蜱蜩蜷蜿螂蜢蝽蝾蝻蝠蝰蝌蝮螋蝓蝣蝼蝤蝙蝥螓螯螨蟒蟆螈螅螭螗螃螫蟥螬螵螳蟋蟓螽蟑蟀蟊蟛蟪蟠蟮蠖蠓蟾蠊蠛蠡蠹蠼缶罂罄罅舐竺竽笈笃笄笕笊笫笏筇笸笪笙笮笱笠笥笤笳笾笞筘筚筅筵筌筝筠筮筻筢筲筱箐箦箧箸箬箝箨箅箪箜箢箫箴篑篁篌篝篚篥篦篪簌篾篼簏簖簋簟簪簦簸籁籀臾舁舂舄臬衄舡舢舣舭舯舨舫舸舻舳舴舾艄艉艋艏艚艟艨衾袅袈裘裟襞羝羟羧羯羰羲籼敉粑粝粜粞粢粲粼粽糁糇糌糍糈糅糗糨艮暨羿翎翕翥翡翦翩翮翳糸絷綦綮繇纛麸麴赳趄趔趑趱赧赭豇豉酊酐酎酏酤酢酡酰酩酯酽酾酲酴酹醌醅醐醍醑醢醣醪醭醮醯醵醴醺豕鹾趸跫踅蹙蹩趵趿趼趺跄跖跗跚跞跎跏跛跆跬跷跸跣跹跻跤踉跽踔踝踟踬踮踣踯踺蹀踹踵踽踱蹉蹁蹂蹑蹒蹊蹰蹶蹼蹯蹴躅躏躔躐躜躞豸貂貊貅貘貔斛觖觞觚觜觥觫觯訾謦靓雩雳雯霆霁霈霏霎霪霭霰霾龀龃龅龆龇龈龉龊龌黾鼋鼍隹隼隽雎雒瞿雠銎銮鋈錾鍪鏊鎏鐾鑫鱿鲂鲅鲆鲇鲈稣鲋鲎鲐鲑鲒鲔鲕鲚鲛鲞鲟鲠鲡鲢鲣鲥鲦鲧鲨鲩鲫鲭鲮鲰鲱鲲鲳鲴鲵鲶鲷鲺鲻鲼鲽鳄鳅鳆鳇鳊鳋鳌鳍鳎鳏鳐鳓鳔鳕鳗鳘鳙鳜鳝鳟鳢靼鞅鞑鞒鞔鞯鞫鞣鞲鞴骱骰骷鹘骶骺骼髁髀髅髂髋髌髑魅魃魇魉魈魍魑飨餍餮饕饔髟髡髦髯髫髻髭髹鬈鬏鬓鬟鬣麽麾縻麂麇麈麋麒鏖麝麟黛黜黝黠黟黢黩黧黥黪黯鼢鼬鼯鼹鼷鼽鼾齄'

// GBK 字节流解码为字符串（纯JS实现，覆盖 GB2312 全部汉字与符号）
function decodeGBK(bytes) {
  var out = []
  var i = 0
  var len = bytes.length
  while (i < len) {
    var b = bytes[i]
    if (b < 0x80) { out.push(String.fromCharCode(b)); i += 1; continue }
    var t = i + 1 < len ? bytes[i + 1] : -1
    if (b >= 0xA1 && b <= 0xFE && t >= 0xA1 && t <= 0xFE) {
      var ch = GBK_TABLE.charCodeAt((b - 0xA1) * 94 + (t - 0xA1))
      if (ch > 0) { out.push(String.fromCharCode(ch)); i += 2; continue }
    }
    out.push('?')
    i += 2
  }
  return out.join('')
}

// ==== zlib/deflate 解压（tiny-inflate，纯JS实现） ====
var inflate = (function () {
var TINF_OK = 0;
var TINF_DATA_ERROR = -3;

function Tree() {
  this.table = new Uint16Array(16);   /* table of code length counts */
  this.trans = new Uint16Array(288);  /* code -> symbol translation table */
}

function Data(source, dest) {
  this.source = source;
  this.sourceIndex = 0;
  this.tag = 0;
  this.bitcount = 0;
  
  this.dest = dest;
  this.destLen = 0;
  
  this.ltree = new Tree();  /* dynamic length/symbol tree */
  this.dtree = new Tree();  /* dynamic distance tree */
}

/* --------------------------------------------------- *
 * -- uninitialized global data (static structures) -- *
 * --------------------------------------------------- */

var sltree = new Tree();
var sdtree = new Tree();

/* extra bits and base tables for length codes */
var length_bits = new Uint8Array(30);
var length_base = new Uint16Array(30);

/* extra bits and base tables for distance codes */
var dist_bits = new Uint8Array(30);
var dist_base = new Uint16Array(30);

/* special ordering of code length codes */
var clcidx = new Uint8Array([
  16, 17, 18, 0, 8, 7, 9, 6,
  10, 5, 11, 4, 12, 3, 13, 2,
  14, 1, 15
]);

/* used by tinf_decode_trees, avoids allocations every call */
var code_tree = new Tree();
var lengths = new Uint8Array(288 + 32);

/* ----------------------- *
 * -- utility functions -- *
 * ----------------------- */

/* build extra bits and base tables */
function tinf_build_bits_base(bits, base, delta, first) {
  var i, sum;

  /* build bits table */
  for (i = 0; i < delta; ++i) bits[i] = 0;
  for (i = 0; i < 30 - delta; ++i) bits[i + delta] = i / delta | 0;

  /* build base table */
  for (sum = first, i = 0; i < 30; ++i) {
    base[i] = sum;
    sum += 1 << bits[i];
  }
}

/* build the fixed huffman trees */
function tinf_build_fixed_trees(lt, dt) {
  var i;

  /* build fixed length tree */
  for (i = 0; i < 7; ++i) lt.table[i] = 0;

  lt.table[7] = 24;
  lt.table[8] = 152;
  lt.table[9] = 112;

  for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;

  /* build fixed distance tree */
  for (i = 0; i < 5; ++i) dt.table[i] = 0;

  dt.table[5] = 32;

  for (i = 0; i < 32; ++i) dt.trans[i] = i;
}

/* given an array of code lengths, build a tree */
var offs = new Uint16Array(16);

function tinf_build_tree(t, lengths, off, num) {
  var i, sum;

  /* clear code length count table */
  for (i = 0; i < 16; ++i) t.table[i] = 0;

  /* scan symbol lengths, and sum code length counts */
  for (i = 0; i < num; ++i) t.table[lengths[off + i]]++;

  t.table[0] = 0;

  /* compute offset table for distribution sort */
  for (sum = 0, i = 0; i < 16; ++i) {
    offs[i] = sum;
    sum += t.table[i];
  }

  /* create code->symbol translation table (symbols sorted by code) */
  for (i = 0; i < num; ++i) {
    if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
  }
}

/* ---------------------- *
 * -- decode functions -- *
 * ---------------------- */

/* get one bit from source stream */
function tinf_getbit(d) {
  /* check if tag is empty */
  if (!d.bitcount--) {
    /* load next tag */
    d.tag = d.source[d.sourceIndex++];
    d.bitcount = 7;
  }

  /* shift bit out of tag */
  var bit = d.tag & 1;
  d.tag >>>= 1;

  return bit;
}

/* read a num bit value from a stream and add base */
function tinf_read_bits(d, num, base) {
  if (!num)
    return base;

  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }

  var val = d.tag & (0xffff >>> (16 - num));
  d.tag >>>= num;
  d.bitcount -= num;
  return val + base;
}

/* given a data stream and a tree, decode a symbol */
function tinf_decode_symbol(d, t) {
  while (d.bitcount < 24) {
    d.tag |= d.source[d.sourceIndex++] << d.bitcount;
    d.bitcount += 8;
  }
  
  var sum = 0, cur = 0, len = 0;
  var tag = d.tag;

  /* get more bits while code value is above sum */
  do {
    cur = 2 * cur + (tag & 1);
    tag >>>= 1;
    ++len;

    sum += t.table[len];
    cur -= t.table[len];
  } while (cur >= 0);
  
  d.tag = tag;
  d.bitcount -= len;

  return t.trans[sum + cur];
}

/* given a data stream, decode dynamic trees from it */
function tinf_decode_trees(d, lt, dt) {
  var hlit, hdist, hclen;
  var i, num, length;

  /* get 5 bits HLIT (257-286) */
  hlit = tinf_read_bits(d, 5, 257);

  /* get 5 bits HDIST (1-32) */
  hdist = tinf_read_bits(d, 5, 1);

  /* get 4 bits HCLEN (4-19) */
  hclen = tinf_read_bits(d, 4, 4);

  for (i = 0; i < 19; ++i) lengths[i] = 0;

  /* read code lengths for code length alphabet */
  for (i = 0; i < hclen; ++i) {
    /* get 3 bits code length (0-7) */
    var clen = tinf_read_bits(d, 3, 0);
    lengths[clcidx[i]] = clen;
  }

  /* build code length tree */
  tinf_build_tree(code_tree, lengths, 0, 19);

  /* decode code lengths for the dynamic trees */
  for (num = 0; num < hlit + hdist;) {
    var sym = tinf_decode_symbol(d, code_tree);

    switch (sym) {
      case 16:
        /* copy previous code length 3-6 times (read 2 bits) */
        var prev = lengths[num - 1];
        for (length = tinf_read_bits(d, 2, 3); length; --length) {
          lengths[num++] = prev;
        }
        break;
      case 17:
        /* repeat code length 0 for 3-10 times (read 3 bits) */
        for (length = tinf_read_bits(d, 3, 3); length; --length) {
          lengths[num++] = 0;
        }
        break;
      case 18:
        /* repeat code length 0 for 11-138 times (read 7 bits) */
        for (length = tinf_read_bits(d, 7, 11); length; --length) {
          lengths[num++] = 0;
        }
        break;
      default:
        /* values 0-15 represent the actual code lengths */
        lengths[num++] = sym;
        break;
    }
  }

  /* build dynamic trees */
  tinf_build_tree(lt, lengths, 0, hlit);
  tinf_build_tree(dt, lengths, hlit, hdist);
}

/* ----------------------------- *
 * -- block inflate functions -- *
 * ----------------------------- */

/* given a stream and two trees, inflate a block of data */
function tinf_inflate_block_data(d, lt, dt) {
  while (1) {
    var sym = tinf_decode_symbol(d, lt);

    /* check for end of block */
    if (sym === 256) {
      return TINF_OK;
    }

    if (sym < 256) {
      d.dest[d.destLen++] = sym;
    } else {
      var length, dist, offs;
      var i;

      sym -= 257;

      /* possibly get more bits from length code */
      length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

      dist = tinf_decode_symbol(d, dt);

      /* possibly get more bits from distance code */
      offs = d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

      /* copy match */
      for (i = offs; i < offs + length; ++i) {
        d.dest[d.destLen++] = d.dest[i];
      }
    }
  }
}

/* inflate an uncompressed block of data */
function tinf_inflate_uncompressed_block(d) {
  var length, invlength;
  var i;
  
  /* unread from bitbuffer */
  while (d.bitcount > 8) {
    d.sourceIndex--;
    d.bitcount -= 8;
  }

  /* get length */
  length = d.source[d.sourceIndex + 1];
  length = 256 * length + d.source[d.sourceIndex];

  /* get one's complement of length */
  invlength = d.source[d.sourceIndex + 3];
  invlength = 256 * invlength + d.source[d.sourceIndex + 2];

  /* check length */
  if (length !== (~invlength & 0x0000ffff))
    return TINF_DATA_ERROR;

  d.sourceIndex += 4;

  /* copy block */
  for (i = length; i; --i)
    d.dest[d.destLen++] = d.source[d.sourceIndex++];

  /* make sure we start next block on a byte boundary */
  d.bitcount = 0;

  return TINF_OK;
}

/* inflate stream from source to dest */
function tinf_uncompress(source, dest) {
  var d = new Data(source, dest);
  var bfinal, btype, res;

  do {
    /* read final block flag */
    bfinal = tinf_getbit(d);

    /* read block type (2 bits) */
    btype = tinf_read_bits(d, 2, 0);

    /* decompress block */
    switch (btype) {
      case 0:
        /* decompress uncompressed block */
        res = tinf_inflate_uncompressed_block(d);
        break;
      case 1:
        /* decompress block with fixed huffman trees */
        res = tinf_inflate_block_data(d, sltree, sdtree);
        break;
      case 2:
        /* decompress block with dynamic huffman trees */
        tinf_decode_trees(d, d.ltree, d.dtree);
        res = tinf_inflate_block_data(d, d.ltree, d.dtree);
        break;
      default:
        res = TINF_DATA_ERROR;
    }

    if (res !== TINF_OK)
      throw new Error('Data error');

  } while (!bfinal);

  if (d.destLen < d.dest.length) {
    if (typeof d.dest.slice === 'function')
      return d.dest.slice(0, d.destLen);
    else
      return d.dest.subarray(0, d.destLen);
  }
  
  return d.dest;
}

/* -------------------- *
 * -- initialization -- *
 * -------------------- */

/* build fixed huffman trees */
tinf_build_fixed_trees(sltree, sdtree);

/* build extra bits and base tables */
tinf_build_bits_base(length_bits, length_base, 4, 3);
tinf_build_bits_base(dist_bits, dist_base, 2, 1);

/* fix a special case */
length_bits[28] = 0;
length_base[28] = 258;
return tinf_uncompress
})()

// 解压 zlib 流：自动定位 zlib 头(78 xx)，跳过2字节，outSize 为预分配大小
function zlibInflate(bytes, outSize) {
  try {
    if (!bytes || bytes.length < 6) return null
    var limit = Math.min(bytes.length - 2, 512)
    var start = -1
    for (var i = 0; i < limit; i++) {
      var b1 = bytes[i]
      if (b1 === 0x78) {
        var b2 = bytes[i + 1]
        if (b2 === 0x01 || b2 === 0x5e || b2 === 0x9c || b2 === 0xda) { start = i; break }
      }
    }
    if (start < 0) return null
    var out = new Uint8Array(outSize > 0 ? outSize : 262144)
    var res = inflate(new Uint8Array(bytes.subarray(start + 2)), out)
    if (!res || !res.length) return null
    return res
  } catch (e) {
    log('[酷我音乐] 解压异常:', e && e.message)
    return null
  }
}

// ==== DES 加密（酷我播放 query 加密，密钥 ylzsxkwm，BigInt 实现） ====
var kwEncryptQuery = (function () {
  var SECRET_KEY = strToBytes('ylzsxkwm')

  function BigInt_available() { return typeof BigInt === 'function' }

  var Long = function (n) {
    var bN = BigInt(n)
    return {
      low: Number(bN),
      valueOf: function () { return bN.valueOf() },
      toString: function () { return bN.toString() },
      not: function () { return Long(~bN) },
      isNegative: function () { return bN < 0 },
      or: function (x) { return Long(bN | BigInt(x)) },
      and: function (x) { return Long(bN & BigInt(x)) },
      xor: function (x) { return Long(bN ^ BigInt(x)) },
      equals: function (x) { return bN === BigInt(x) },
      multiply: function (x) { return Long(bN * BigInt(x)) },
      shiftLeft: function (x) { return Long(bN << BigInt(x)) },
      shiftRight: function (x) { return Long(bN >> BigInt(x)) },
    }
  }
  var range = function (n) {
    var a = []
    for (var i = 0; i < n; i++) a.push(i)
    return a
  }
  var power = function (base, index) {
    var r = Long(1)
    for (var i = 0; i < index; i++) r = r.multiply(base)
    return r
  }
  var LongArray = function () {
    var arr = []
    for (var i = 0; i < arguments.length; i++) arr.push(arguments[i] === -1 ? Long(-1) : Long(arguments[i]))
    return arr
  }

  var arrayE = LongArray(31, 0, 1, 2, 3, 4, -1, -1, 3, 4, 5, 6, 7, 8, -1, -1, 7, 8, 9, 10, 11, 12, -1, -1, 11, 12, 13, 14, 15, 16, -1, -1, 15, 16, 17, 18, 19, 20, -1, -1, 19, 20, 21, 22, 23, 24, -1, -1, 23, 24, 25, 26, 27, 28, -1, -1, 27, 28, 29, 30, 31, 30, -1, -1)
  var arrayIP = LongArray(57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7, 56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6)
  var arrayIP_1 = LongArray(39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25, 32, 0, 40, 8, 48, 16, 56, 24)
  var arrayLs = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
  var arrayLsMask = LongArray(0, 0x100001, 0x300003)
  var arrayMask = range(64).map(function (n) { return power(2, n) })
  arrayMask[arrayMask.length - 1] = arrayMask[arrayMask.length - 1].multiply(-1)
  var arrayP = LongArray(15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5, 21, 10, 3, 24)
  var arrayPC_1 = LongArray(56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3)
  var arrayPC_2 = LongArray(13, 16, 10, 23, 0, 4, -1, -1, 2, 27, 14, 5, 20, 9, -1, -1, 22, 18, 11, 3, 25, 7, -1, -1, 15, 6, 26, 19, 12, 1, -1, -1, 40, 51, 30, 36, 46, 54, -1, -1, 29, 39, 50, 44, 32, 47, -1, -1, 43, 48, 38, 55, 33, 52, -1, -1, 45, 41, 49, 35, 28, 31, -1, -1)
  var matrixNSBox = [
    [14, 4, 3, 15, 2, 13, 5, 3, 13, 14, 6, 9, 11, 2, 0, 5, 4, 1, 10, 12, 15, 6, 9, 10, 1, 8, 12, 7, 8, 11, 7, 0, 0, 15, 10, 5, 14, 4, 9, 10, 7, 8, 12, 3, 13, 1, 3, 6, 15, 12, 6, 11, 2, 9, 5, 0, 4, 2, 11, 14, 1, 7, 8, 13],
    [15, 0, 9, 5, 6, 10, 12, 9, 8, 7, 2, 12, 3, 13, 5, 2, 1, 14, 7, 8, 11, 4, 0, 3, 14, 11, 13, 6, 4, 1, 10, 15, 3, 13, 12, 11, 15, 3, 6, 0, 4, 10, 1, 7, 8, 4, 11, 14, 13, 8, 0, 6, 2, 15, 9, 5, 7, 1, 10, 12, 14, 2, 5, 9],
    [10, 13, 1, 11, 6, 8, 11, 5, 9, 4, 12, 2, 15, 3, 2, 14, 0, 6, 13, 1, 3, 15, 4, 10, 14, 9, 7, 12, 5, 0, 8, 7, 13, 1, 2, 4, 3, 6, 12, 11, 0, 13, 5, 14, 6, 8, 15, 2, 7, 10, 8, 15, 4, 9, 11, 5, 9, 0, 14, 3, 10, 7, 1, 12],
    [7, 10, 1, 15, 0, 12, 11, 5, 14, 9, 8, 3, 9, 7, 4, 8, 13, 6, 2, 1, 6, 11, 12, 2, 3, 0, 5, 14, 10, 13, 15, 4, 13, 3, 4, 9, 6, 10, 1, 12, 11, 0, 2, 5, 0, 13, 14, 2, 8, 15, 7, 4, 15, 1, 10, 7, 5, 6, 12, 11, 3, 8, 9, 14],
    [2, 4, 8, 15, 7, 10, 13, 6, 4, 1, 3, 12, 11, 7, 14, 0, 12, 2, 5, 9, 10, 13, 0, 3, 1, 11, 15, 5, 6, 8, 9, 14, 14, 11, 5, 6, 4, 1, 3, 10, 2, 12, 15, 0, 13, 2, 8, 5, 11, 8, 0, 15, 7, 14, 9, 4, 12, 7, 10, 9, 1, 13, 6, 3],
    [12, 9, 0, 7, 9, 2, 14, 1, 10, 15, 3, 4, 6, 12, 5, 11, 1, 14, 13, 0, 2, 8, 7, 13, 15, 5, 4, 10, 8, 3, 11, 6, 10, 4, 6, 11, 7, 9, 0, 6, 4, 2, 13, 1, 9, 15, 3, 8, 15, 3, 1, 14, 12, 5, 11, 0, 2, 12, 14, 7, 5, 10, 8, 13],
    [4, 1, 3, 10, 15, 12, 5, 0, 2, 11, 9, 6, 8, 7, 6, 9, 11, 4, 12, 15, 0, 3, 10, 5, 14, 13, 7, 8, 13, 14, 1, 2, 13, 6, 14, 9, 4, 1, 2, 14, 11, 13, 5, 0, 1, 10, 8, 3, 0, 11, 3, 5, 9, 4, 15, 2, 7, 8, 12, 15, 10, 7, 6, 12],
    [13, 7, 10, 0, 6, 9, 5, 15, 8, 4, 3, 10, 11, 14, 12, 5, 2, 11, 9, 6, 15, 12, 0, 3, 4, 1, 14, 13, 1, 2, 7, 8, 1, 2, 12, 15, 10, 4, 0, 3, 13, 14, 6, 9, 7, 8, 9, 6, 15, 1, 5, 12, 3, 10, 14, 5, 8, 7, 11, 0, 4, 13, 2, 11],
  ]

  function bitTransform(arrInt, n, l) {
    var l2 = Long(0)
    for (var i = 0; i < n; i++) {
      var v = arrInt[i]
      if (v.isNegative()) continue
      if (l.and(arrayMask[v.low]).equals(0)) continue
      l2 = l2.or(arrayMask[i])
    }
    return l2
  }

  function DES64(longs, l) {
    var pR = range(8).map(function () { return Long(0) })
    var pSource = [Long(0), Long(0)]
    var L = Long(0)
    var R = Long(0)
    var out = bitTransform(arrayIP, 64, l)
    pSource[0] = out.and(0xffffffff)
    pSource[1] = out.and(-4294967296).shiftRight(32)
    for (var i = 0; i < 16; i++) {
      var SOut = Long(0)
      R = Long(pSource[1])
      R = bitTransform(arrayE, 64, R)
      R = R.xor(longs[i])
      for (var j = 0; j < 8; j++) pR[j] = R.shiftRight(j * 8).and(255)
      for (var k = 7; k >= 0; k--) SOut = SOut.shiftLeft(4).or(matrixNSBox[k][pR[k].low])
      R = bitTransform(arrayP, 32, SOut)
      L = Long(pSource[0])
      pSource[0] = Long(pSource[1])
      pSource[1] = L.xor(R)
    }
    pSource.reverse()
    out = pSource[1].shiftLeft(32).and(-4294967296).or(pSource[0].and(0xffffffff))
    return bitTransform(arrayIP_1, 64, out)
  }

  function subKeys(l, longs, n) {
    var l2 = bitTransform(arrayPC_1, 56, l)
    for (var i = 0; i < 16; i++) {
      l2 = l2.and(arrayLsMask[arrayLs[i]]).shiftLeft(28 - arrayLs[i]).or(l2.and(arrayLsMask[arrayLs[i]].not()).shiftRight(arrayLs[i]))
      longs[i] = bitTransform(arrayPC_2, 64, l2)
    }
    if (n === 1) {
      for (var j = 0; j < 8; j++) {
        var tmp = longs[j]
        longs[j] = longs[15 - j]
        longs[15 - j] = tmp
      }
    }
  }

  function crypt(msg, key, mode) {
    var l = Long(0)
    for (var i = 0; i < 8; i++) l = Long(key[i]).shiftLeft(i * 8).or(l)
    var j = Math.floor(msg.length / 8)
    var arrLong1 = range(16).map(function () { return Long(0) })
    subKeys(l, arrLong1, mode)
    var arrLong2 = range(j).map(function () { return Long(0) })
    for (var m = 0; m < j; m++) {
      for (var n = 0; n < 8; n++) arrLong2[m] = Long(msg[n + m * 8]).shiftLeft(n * 8).or(arrLong2[m])
    }
    var arrLong3 = range(j + 1).map(function () { return Long(0) })
    for (var i1 = 0; i1 < j; i1++) arrLong3[i1] = DES64(arrLong1, arrLong2[i1])
    var arrByte1 = msg.slice(j * 8)
    var l2 = Long(0)
    for (var i2 = 0; i2 < msg.length % 8; i2++) l2 = Long(arrByte1[i2]).shiftLeft(i2 * 8).or(l2)
    if (arrByte1.length || mode === 0) arrLong3[j] = DES64(arrLong1, l2)
    var out = new Uint8Array(8 * arrLong3.length)
    var i4 = 0
    for (var i3 = 0; i3 < arrLong3.length; i3++) {
      var l3 = arrLong3[i3]
      for (var i6 = 0; i6 < 8; i6++) {
        out[i4] = l3.shiftRight(i6 * 8).and(255).low
        i4 += 1
      }
    }
    return out
  }

  function encrypt(msg) { return crypt(msg, SECRET_KEY, 0) }

  return {
    encryptQuery: function (query) {
      if (!BigInt_available()) throw new Error('当前环境不支持BigInt')
      return bytesToBase64(encrypt(strToBytes(query)))
    },
  }
})()

// ==== HTTP 封装（回调对齐洛雪两参数/三参数） ====
function httpGetRaw(url, headers, binaryMode) {
  return new Promise(function (resolve, reject) {
    try {
      var opts = {
        method: 'GET',
        headers: headers || {},
        timeout: TIMEOUT,
      }
      if (binaryMode) opts.binaryMode = true
      request(url, opts, function (err, resp, body) {
        if (err) return reject(err)
        var b = resp && resp.body !== undefined ? resp.body : (body !== undefined ? body : '')
        resolve(b)
      })
    } catch (e) { reject(e) }
  })
}
function httpGetText(url, headers) {
  return httpGetRaw(url, headers, false).then(function (b) { return bodyToText(b) })
}
function httpGetJson(url, headers) {
  return httpGetRaw(url, headers, false).then(function (b) { return toJson(b) })
}
// 二进制请求：返回 Uint8Array
function httpGetBytes(url, headers) {
  return httpGetRaw(url, headers, true).then(function (b) {
    if (b == null) return null
    if (typeof b === 'string') return base64ToBytes(b)
    if (typeof b === 'object') {
      try {
        if (b.byteLength !== undefined) {
          if (b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + b.byteLength))
          return new Uint8Array(b)
        }
      } catch (e) { /* ignore */ }
    }
    return null
  })
}

// ==== 搜索 ====
// HTML 实体解码（搜索结果可能含 &amp; &nbsp; 等）
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}
function normItem(x) {
  if (!x) return null
  var rid = String(x.MUSICRID || x.musicrid || x.rid || '')
  rid = rid.replace(/^MUSIC_/, '')
  if (!rid || !/^\d+$/.test(rid)) return null
  var name = decodeEntities(String(x.SONGNAME || x.NAME || x.songName || x.name || ''))
  var artist = decodeEntities(String(x.ARTIST || x.artist || ''))
  // r.s 老接口里的转义残留（如 "周杰伦\&林俊杰"）
  name = name.replace(/\\([&,+()])/g, '$1')
  artist = artist.replace(/\\([&,+()])/g, '$1')
  return {
    rid: rid,
    name: name,
    artist: artist,
    album: decodeEntities(String(x.ALBUM || x.album || '')),
    duration: parseInt(x.DURATION || x.duration || 0, 10) || 0,
  }
}

// 主搜索：www 搜索页 JSON 接口（无需鉴权）
function wwwSearch(keyword) {
  var url = 'http://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0' +
    '&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1' +
    '&pn=0&rn=30&all=' + encodeURIComponent(keyword)
  return httpGetJson(url, { 'User-Agent': UA_WEB, Referer: 'http://www.kuwo.cn/' }).then(function (json) {
    if (!json || !json.abslist || !json.abslist.length) return []
    var items = []
    for (var i = 0; i < json.abslist.length; i++) {
      var it = normItem(json.abslist[i])
      if (it) items.push(it)
    }
    return items
  })
}

// 备选搜索：r.s 老接口（伪JSON：单引号 + \\uXXXX 双重转义）
function rsSearch(keyword) {
  var url = 'http://search.kuwo.cn/r.s?all=' + encodeURIComponent(keyword) +
    '&ft=music&client=kt&itemset=web_2013&pn=0&rn=30&rformat=json&encoding=utf8'
  return httpGetText(url, { 'User-Agent': UA_WEB, Referer: 'http://www.kuwo.cn/' }).then(function (text) {
    if (!text) return []
    var t = String(text).replace(/\\\\u([0-9a-fA-F]{4})/g, '\\u$1').replace(/'([^']*)'/g, '"$1"')
    var json
    try { json = JSON.parse(t) } catch (e) { return [] }
    if (!json || !json.abslist || !json.abslist.length) return []
    var items = []
    for (var i = 0; i < json.abslist.length; i++) {
      var it = normItem(json.abslist[i])
      if (it) items.push(it)
    }
    return items
  })
}

function searchSongs(keyword) {
  var hit = cacheGet(searchCache, keyword)
  if (hit) return Promise.resolve(hit)
  return wwwSearch(keyword).then(function (items) {
    if (items.length) return items
    return rsSearch(keyword).catch(function () { return [] })
  }).then(function (items) {
    cacheSet(searchCache, keyword, items, SEARCH_TTL)
    return items
  }).catch(function () {
    return rsSearch(keyword).then(function (items) {
      cacheSet(searchCache, keyword, items, SEARCH_TTL)
      return items
    }).catch(function () { return [] })
  })
}

// ==== 匹配 ====
function normalizeStr(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '')
}
function buildKeyword(musicInfo) {
  var name = (musicInfo && (musicInfo.name || musicInfo.songName)) || ''
  var singer = musicInfo && (musicInfo.singer || musicInfo.singerName || musicInfo.artist || '')
  if (singer && typeof singer !== 'string') {
    try { singer = Array.isArray(singer) ? singer.join(' ') : String(singer) } catch (e) { singer = '' }
  }
  singer = singer || ''
  name = String(name || '').trim()
  singer = String(singer).trim()
  if (name && singer) return name + ' ' + singer
  return name || singer
}

// 评分选最佳：歌名精确 > 歌名包含 > 歌手匹配；时长相似加分；过短片段降权
function pickBest(items, name, singer, interval) {
  var n = normalizeStr(name)
  var s = normalizeStr(singer)
  var best = null
  var bestScore = -1
  for (var i = 0; i < items.length; i++) {
    var it = items[i]
    var iname = normalizeStr(it.name)
    var iartist = normalizeStr(it.artist)
    var score = 0
    if (n && iname === n) score += 100
    else if (n && iname.indexOf(n) !== -1) score += 50
    if (s && iartist.indexOf(s) !== -1) score += 40
    else if (s) {
      var parts = s.split(/[,，&、+/\s]+/)
      var hitAny = false
      for (var p = 0; p < parts.length; p++) {
        if (parts[p] && parts[p].length >= 2 && iartist.indexOf(parts[p]) !== -1) { hitAny = true; break }
      }
      if (hitAny) score += 20
    }
    if (interval > 0 && it.duration > 0) {
      var d = Math.abs(it.duration - interval)
      if (d <= 3) score += 25
      else if (d <= 8) score += 12
      else if (d >= 30) score -= 10
    }
    if (it.duration > 0 && it.duration < 15) score -= 15
    if (score > bestScore) { bestScore = score; best = it }
  }
  return best
}

function matchSong(musicInfo) {
  var name = String((musicInfo && (musicInfo.name || musicInfo.songName)) || '').trim()
  var singer = String((musicInfo && (musicInfo.singer || musicInfo.singerName || musicInfo.artist)) || '').trim()
  var interval = Number(musicInfo && musicInfo.interval) || 0
  var kw = buildKeyword(musicInfo)
  if (!kw) return Promise.reject(new Error('缺少歌曲信息'))
  return searchSongs(kw).then(function (items) {
    if (!items.length && name && singer) return searchSongs(name)
    return items
  }).then(function (items) {
    if (!items.length) return Promise.reject(new Error('酷我站内未找到: ' + kw))
    var song = pickBest(items, name, singer, interval)
    if (!song) return Promise.reject(new Error('酷我站内匹配失败: ' + kw))
    return song
  })
}

// ==== 播放 ====
// 音质 -> 尝试参数序列（format + 可选 br），自动降级
function buildAttempts(quality) {
  var base = []
  if (quality === 'flac') base = [{ f: 'flac' }, { f: 'mp3', br: '320kmp3' }]
  else if (quality === '320k') base = [{ f: 'mp3', br: '320kmp3' }]
  else base = [{ f: 'mp3' }]
  var tail = [{ f: 'flac' }, { f: 'mp3', br: '320kmp3' }, { f: 'mp3' }]
  var seen = {}
  var out = []
  function push(a) {
    var k = a.f + '|' + (a.br || '')
    if (!seen[k]) { seen[k] = true; out.push(a) }
  }
  for (var i = 0; i < base.length; i++) push(base[i])
  for (var j = 0; j < tail.length; j++) push(tail[j])
  return out
}

function resolvePlayUrl(rid, quality) {
  var attempts = buildAttempts(quality)
  function tryOne(idx) {
    if (idx >= attempts.length) return Promise.reject(new Error('酷我播放解析失败(rid=' + rid + ')'))
    var a = attempts[idx]
    var key = rid + '|' + a.f + '|' + (a.br || '')
    var hit = cacheGet(playCache, key)
    if (hit) return Promise.resolve(hit)
    var query = 'user=0&corp=kuwo&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1' +
      '&type=convert_url2&sig=0&format=' + a.f + (a.br ? '&br=' + a.br : '') + '&rid=' + encodeURIComponent(rid)
    var q
    try { q = kwEncryptQuery.encryptQuery(query) } catch (e) { return Promise.reject(e) }
    var url = 'http://mobi.kuwo.cn/mobi.s?f=kuwo&q=' + encodeURIComponent(q)
    return httpGetText(url, { 'User-Agent': UA_APP, Referer: 'http://mobi.kuwo.cn/' }).then(function (text) {
      var m = /url=(https?:\/\/[^\r\n]+)/i.exec(text || '')
      if (m && /^https?:\/\//i.test(m[1])) {
        var playUrl = m[1]
        cacheSet(playCache, key, playUrl, PLAY_TTL)
        return playUrl
      }
      return tryOne(idx + 1)
    }).catch(function () {
      return tryOne(idx + 1)
    })
  }
  return tryOne(0)
}

// ==== 歌词 ====
function cleanLrc(lrcText) {
  if (!lrcText) return ''
  var lines = String(lrcText).split(/\r\n|\r|\n/)
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    if (/^\[(kuwo|ver):/i.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

function fetchLyric(rid) {
  var hit = cacheGet(lyricCache, rid)
  if (hit !== null) return Promise.resolve(hit)
  var params = 'user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_' + encodeURIComponent(rid)
  var token = bytesToBase64(xorCrypt(strToBytes(params), 'yeelion'))
  // token 含 + / 时按查询串规则转义，= 保留（老客户端即如此传参）
  var tokenQ = token.replace(/\+/g, '%2B').replace(/\//g, '%2F')
  var url = 'http://newlyric.kuwo.cn/newlyric.lrc?' + tokenQ
  return httpGetBytes(url, { 'User-Agent': UA_WEB, Referer: 'http://m.kuwo.cn/' }).then(function (bytes) {
    if (!bytes || bytes.length < 16) throw new Error('歌词响应异常')
    // 文本头中解析 lrc_length 用于解压缓冲预分配
    var headLimit = Math.min(bytes.length - 2, 2048)
    var headEnd = -1
    for (var i = 0; i < headLimit; i++) {
      if (bytes[i] === 0x78) {
        var b2 = bytes[i + 1]
        if (b2 === 0x01 || b2 === 0x5e || b2 === 0x9c || b2 === 0xda) { headEnd = i; break }
      }
    }
    if (headEnd < 0) throw new Error('歌词压缩数据未找到')
    var head = ''
    for (var j = 0; j < headEnd; j++) head += String.fromCharCode(bytes[j])
    var lm = /lrc_length=(\d+)/.exec(head)
    var lrcLen = lm ? (parseInt(lm[1], 10) || 0) : 0
    var outSize = Math.max(lrcLen + 64, bytes.length * 16 + 65536)
    var unz = zlibInflate(bytes.subarray(headEnd), outSize)
    if (!unz) throw new Error('歌词解压失败')
    var lrc = cleanLrc(decodeGBK(unz))
    if (!lrc) throw new Error('歌词为空')
    cacheSet(lyricCache, rid, lrc, LYRIC_TTL)
    return lrc
  })
}

// ==== 洛雪 API 注册 ====
function lyricKey(musicInfo) {
  var mi = musicInfo || {}
  return String(mi.hash || mi.songmid || mi.id || ((mi.name || '') + '|' + (mi.singer || ''))) || ''
}

function isKwRid(s) {
  return /^\d{3,12}$/.test(String(s || ''))
}

const apis = {}
;['kg', 'tx', 'wy', 'kw', 'mg'].forEach(function (src) {
  apis[src] = {
    musicUrl: function (musicInfo, quality) {
      var key = lyricKey(musicInfo)
      // kw 平台：songmid 即酷我 rid，直接解析（快速路径）
      var direct = src === 'kw' && isKwRid(musicInfo && musicInfo.songmid) ? String(musicInfo.songmid) : null
      var doMatch = function () {
        return matchSong(musicInfo).then(function (song) {
          if (key) ridCache[key] = song.rid
          return resolvePlayUrl(song.rid, quality)
        })
      }
      if (direct) {
        return resolvePlayUrl(direct, quality).catch(function () {
          if (key) ridCache[key] = direct
          return doMatch()
        })
      }
      return doMatch()
    },
    lyric: function (musicInfo) {
      var key = lyricKey(musicInfo)
      var rid = key ? ridCache[key] : null
      if (!rid && src === 'kw' && isKwRid(musicInfo && musicInfo.songmid)) rid = String(musicInfo.songmid)
      var task
      if (rid) {
        task = fetchLyric(rid)
      } else {
        task = matchSong(musicInfo).then(function (song) {
          if (key) ridCache[key] = song.rid
          return fetchLyric(song.rid)
        })
      }
      return task.then(function (lrc) {
        return { lyric: lrc || '', tlyric: '' }
      }).catch(function (err) {
        log('[酷我音乐] lyric 失败:', err && err.message)
        return { lyric: '', tlyric: '' }
      })
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
        log('[酷我音乐] musicUrl 失败:', err && err.message)
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
var musicSources = {}
;['kg', 'tx', 'wy', 'kw', 'mg'].forEach(function (src) {
  musicSources[src] = { name: '酷我音乐', type: 'music', actions: ['musicUrl', 'lyric'], qualitys: QUALITYS }
})
send(EVENT_NAMES.inited, {
  status: true,
  sources: musicSources,
})
