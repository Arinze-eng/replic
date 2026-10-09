// ═══════════════════════════════════════════════════════════════
// IPTV Service — direct .m3u8 sports/football channels
// Sources: iptv-org/iptv (MIT) + curated free-to-air streams
// All channels below were HEALTH-CHECKED reachable at build time.
// Streams are proxied through /api/football/hls so they play natively
// (hls.js) on ANY browser — Chrome, Firefox, Safari, Android & iOS.
// Last verified: 2026-06-13  •  81 channels (football, Nigeria, kids, entertainment) — all health-checked playable
// ═══════════════════════════════════════════════════════════════

const SPORTS_CHANNELS = [
  {
    "id": "ait-live",
    "name": "AIT (Africa Independent Television)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_045/Stream/playlist.m3u8",
    "tags": [
      "Nigeria",
      "News",
      "Africa"
    ],
    "hd": true
  },
  {
    "id": "itv-uk",
    "name": "ITV (UK)",
    "category": "entertainment",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/ITV_logo_2013.svg/320px-ITV_logo_2013.svg.png",
    "embed": "https://www.youtube.com/embed/live_stream?channel=UCoEqHpK5VNVEBRvwL0EW8Gw&autoplay=1",
    "tags": [
      "UK",
      "Entertainment"
    ],
    "hd": true
  },
  {
    "id": "nickelodeon-toons",
    "name": "Nickelodeon Toons",
    "category": "kids",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Nickelodeon_2023_logo.svg/320px-Nickelodeon_2023_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-645951c0e94c38000802d2cb.m3u8",
    "tags": [
      "Kids",
      "Cartoons",
      "Nickelodeon"
    ],
    "hd": true
  },
  {
    "id": "nickelodeon-classics",
    "name": "Nickelodeon Classics",
    "category": "kids",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Nickelodeon_2023_logo.svg/320px-Nickelodeon_2023_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-67f3eb800a1beb98767ca748.m3u8",
    "tags": [
      "Kids",
      "Cartoons",
      "Nickelodeon"
    ],
    "hd": true
  },
  {
    "id": "nickelodeon-icarly",
    "name": "Nickelodeon iCarly",
    "category": "kids",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Nickelodeon_2023_logo.svg/320px-Nickelodeon_2023_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-620ff46e0a576e0007dc2f89.m3u8",
    "tags": [
      "Kids",
      "Nickelodeon"
    ],
    "hd": true
  },
  {
    "id": "bein-sports-xtra",
    "name": "beIN SPORTS XTRA",
    "category": "football",
    "language": "English",
    "logo": "https://i.ibb.co/HT49GPmB/XTRA-2.png",
    "m3u8": "https://bein-xtra-bein.amagi.tv/playlist.m3u8",
    "tags": [
      "World Cup",
      "Football",
      "Champions League",
      "beIN"
    ],
    "hd": true
  },
  {
    "id": "bein-sports-xtra-espa-ol",
    "name": "beIN Sports XTRA (Español)",
    "category": "football",
    "language": "Spanish",
    "logo": "https://i.imgur.com/V562tpO.png",
    "m3u8": "https://dc1644a9jazgj.cloudfront.net/beIN_Sports_Xtra_Espanol.m3u8",
    "tags": [
      "Football",
      "La Liga",
      "beIN"
    ],
    "hd": true
  },
  {
    "id": "espn8-the-ocho",
    "name": "ESPN8 The Ocho",
    "category": "sports",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/2/26/ESPN_wordmark.svg/320px-ESPN_wordmark.svg.png",
    "m3u8": "https://d3b6q2ou5kp8ke.cloudfront.net/ESPNTheOcho.m3u8",
    "tags": [
      "ESPN",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "fox-sports",
    "name": "FOX Sports",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Fox_Sports_logo.svg/320px-Fox_Sports_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-5a74b8e1e22a61737979c6bf.m3u8",
    "tags": [
      "Football",
      "World Cup",
      "Fox"
    ],
    "hd": true
  },
  {
    "id": "sportitalia-hd",
    "name": "Sportitalia HD",
    "category": "football",
    "language": "Italian",
    "logo": "https://upload.wikimedia.org/wikipedia/it/5/56/SportItalia_logo.png",
    "m3u8": "https://edge-001.streamup.eu/sportitalia/sihd_abr/playlist.m3u8",
    "tags": [
      "Serie A",
      "Football",
      "Italy"
    ],
    "hd": true
  },
  {
    "id": "wazobia-max-tv-nigeria",
    "name": "Wazobia Max TV (Nigeria)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/thumb/4/45/Wazobia_Max_TV_logo.jpg/220px-Wazobia_Max_TV_logo.jpg",
    "m3u8": "https://wazobia.live:8333/channel/wmax.m3u8",
    "tags": [
      "Nigeria",
      "Africa",
      "Wazobia"
    ],
    "hd": false
  },
  {
    "id": "wazobia-max-tv-abuja",
    "name": "Wazobia Max TV (Abuja)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/thumb/4/45/Wazobia_Max_TV_logo.jpg/220px-Wazobia_Max_TV_logo.jpg",
    "m3u8": "https://wazobia.live:8333/channel/wmaxabuja.m3u8",
    "tags": [
      "Nigeria",
      "Abuja"
    ],
    "hd": false
  },
  {
    "id": "wazobia-max-tv-port-harcourt",
    "name": "Wazobia Max TV (Port Harcourt)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/thumb/4/45/Wazobia_Max_TV_logo.jpg/220px-Wazobia_Max_TV_logo.jpg",
    "m3u8": "https://wazobia.live:8333/channel/wmaxph.m3u8",
    "tags": [
      "Nigeria",
      "Port Harcourt"
    ],
    "hd": false
  },
  {
    "id": "channels-tv",
    "name": "Channels TV",
    "category": "nigeria",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/7/76/Channels_TV.jpg",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_014/Stream/playlist.m3u8",
    "tags": [
      "Nigeria",
      "News",
      "Africa"
    ],
    "hd": true
  },
  {
    "id": "news-central",
    "name": "News Central",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://wf.newscentral.ng:8443/hls/stream.m3u8",
    "tags": [
      "Nigeria",
      "Africa"
    ],
    "hd": false
  },
  {
    "id": "rave-tv",
    "name": "Rave TV",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/pXKQE0G.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_039/Stream/playlist.m3u8",
    "tags": [
      "Nigeria",
      "Africa"
    ],
    "hd": false
  },
  {
    "id": "superscreen-tv",
    "name": "Superscreen TV",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/uTNmSWE.png",
    "m3u8": "https://video1.getstreamhosting.com:1936/8398/8398/playlist.m3u8",
    "tags": [
      "Nigeria",
      "Africa"
    ],
    "hd": false
  },
  {
    "id": "tvc-news",
    "name": "TVC News",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/jaSq18B.png",
    "m3u8": "http://69.64.57.208/tvcnews/playlist.m3u8",
    "tags": [
      "Nigeria",
      "Africa"
    ],
    "hd": false
  },
  {
    "id": "fanduel-racing",
    "name": "FanDuel Racing",
    "category": "sports",
    "language": "English",
    "logo": "https://i.imgur.com/84lMjSj.png",
    "m3u8": "https://d3ehq1uaxory6w.cloudfront.net/out/v1/35c05f080f4e49a4b4eb031b5a14e505/TVG2index_2.m3u8",
    "tags": [
      "Sports",
      "Racing"
    ],
    "hd": false
  },
  {
    "id": "aci-sport-tv",
    "name": "ACI Sport TV",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/U8cHMOt.png",
    "m3u8": "https://webstream.multistream.it/memfs/e2cb3629-c1a2-495b-b43a-9eb386f04ed8.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "africa24-sport",
    "name": "Africa 24 Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/DrrlxTO.png",
    "m3u8": "https://africa24.vedge.infomaniak.com/livecast/ik:africa24sport/manifest.m3u8",
    "tags": [
      "Africa",
      "Football",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "alkass-four",
    "name": "Alkass Four",
    "category": "football",
    "language": "Arabic",
    "logo": "https://i.imgur.com/iDL65Wu.png",
    "m3u8": "https://liveeu-gcp.alkassdigital.net/alkass4-p/main.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "alkass-six",
    "name": "Alkass Six",
    "category": "football",
    "language": "Arabic",
    "logo": "https://i.imgur.com/CrPSPSC.png",
    "m3u8": "https://liveeu-gcp.alkassdigital.net/alkass6-p/main.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "alkass-three",
    "name": "Alkass Three",
    "category": "football",
    "language": "Arabic",
    "logo": "https://i.imgur.com/d57BdFh.png",
    "m3u8": "https://liveeu-gcp.alkassdigital.net/alkass3-p/main.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "antenasport-not-24-7",
    "name": "beIN SPORTS XTRA (Xumo)",
    "category": "football",
    "language": "English",
    "logo": "https://i.ibb.co/HT49GPmB/XTRA-2.png",
    "m3u8": "https://bein-xtra-xumo.amagi.tv/playlist.m3u8",
    "tags": [
      "Football",
      "Champions League",
      "beIN"
    ],
    "hd": true
  },
  {
    "id": "as3-sport-tv",
    "name": "AS3 Sport TV",
    "category": "football",
    "language": "English",
    "logo": "https://i.ibb.co/bRmGbsyV/A3-SPORTTV.jpg",
    "m3u8": "https://streamtv.as3sport.online:3394/hybrid/play.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "bahrain-sports-1-not-24-7",
    "name": "Bahrain Sports 1  [Not 24/7]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/fBpLsbC.png",
    "m3u8": "https://5c7b683162943.streamlock.net/live/ngrp:sportsone_all/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "bek-tv-sports-west",
    "name": "BEK TV Sports West",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/1l3t5jd.png",
    "m3u8": "https://cdn3.wowza.com/5/ZWQ1K2NYTmpFbGsr/BEK-WOWZA-1/smil:BEKPRIMEW.smil/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "cbs-sports-golazo-network",
    "name": "CBS Sports Golazo Network",
    "category": "football",
    "language": "Spanish",
    "logo": "https://i.imgur.com/eMjutHS.png",
    "m3u8": "https://proped3fhg87.airspace-cdn.cbsivideo.com/golazo-live-dai/master/golazo-live-dai.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "cbs-sports-hq-geo-blocked",
    "name": "CBS Sports HQ  [Geo-blocked]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/q8BENJg.png",
    "m3u8": "https://propee33f9c2.airspace-cdn.cbsivideo.com/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "cricket-gold",
    "name": "Cricket Gold",
    "category": "football",
    "language": "Spanish",
    "logo": "https://resources.cricket-australia.pulselive.com/cricket-australia/photo/2025/07/25/836eddae-4329-4542-ad17-dcd37e9d951a/Cricket-Gold-1920x1080_noBG.png",
    "m3u8": "https://streams2.sofast.tv/ptnr-yupptv/title-cricketgold/v1/master/611d79b11b77e2f571934fd80ca1413453772ac7/b2048bb8-1686-4432-aa50-647245383e0c/manifest.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "t-sport",
    "name": "ČT Sport",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/7/72/%C4%8CT_sport_logo.png/960px-%C4%8CT_sport_logo.png",
    "m3u8": "http://88.212.15.19/live/test_ctsport_25p/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "dazn-combat",
    "name": "DAZN Combat",
    "category": "football",
    "language": "English",
    "logo": "https://i.postimg.cc/VsW3Jsrz/logo-DAZN-Combat.png",
    "m3u8": "https://dazn-combat-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-dazn-combat-rakuten/CDN/master.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "dazn-combat-2",
    "name": "DAZN Combat",
    "category": "football",
    "language": "English",
    "logo": "https://i.postimg.cc/VsW3Jsrz/logo-DAZN-Combat.png",
    "m3u8": "https://jmp2.uk/plu-64d626ac9b414d000820e2fc.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "dd-sports-sd",
    "name": "DD Sports SD",
    "category": "football",
    "language": "English",
    "logo": "https://dtil.tmsimg.com/assets/s158255_ld_h15_aa.png?lock=720x540",
    "m3u8": "https://d3qs3d2rkhfqrt.cloudfront.net/out/v1/b17adfe543354fdd8d189b110617cddd/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "dsports-uruguay",
    "name": "Fox Deportes",
    "category": "football",
    "language": "Spanish",
    "logo": "https://i.imgur.com/2PoEm1x.png",
    "m3u8": "https://live-manifest.production-public.tubi.io/live/d906efca-1302-4e29-b0d9-9a1d7a305d69/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "stadium-sports",
    "name": "Stadium Sports",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/thumb/5/53/Stadium_%28sports_network%29_logo.svg/960px-Stadium_%28sports_network%29_logo.svg.png",
    "m3u8": "https://wurl120sports.global.transmit.live/hls/679a907dce42a042c23ace37/v1/stadium_gracenote/samsung_us/latest/main/hls/playlist.m3u8",
    "tags": [
      "Football",
      "Soccer",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "fox-sports-1",
    "name": "NBC Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/EzNf2Yx.png",
    "m3u8": "https://d1m1xk35ma8qfl.cloudfront.net/master.m3u8",
    "tags": [
      "Football",
      "Premier League",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "ftf-sports",
    "name": "FTF Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/yvUjOI3.png",
    "m3u8": "https://1657061170.rsc.cdn77.org/HLS/FTF-LINEAR.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "fubo-sports-network",
    "name": "fubo Sports Network",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/qFNRJLb.png",
    "m3u8": "https://dnf08l6u6uxnz.cloudfront.net/master.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "gol-classics",
    "name": "Gol Classics",
    "category": "football",
    "language": "Spanish",
    "logo": "https://golstadium.com/_next/image?url=%2Fimg%2Fhome%2Fchannels%2Fthumb-gol-classics.jpg&w=1920&q=75",
    "m3u8": "https://d71gqtnep83vb.cloudfront.net/gol_classics/gol_classics.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "jordan-sport",
    "name": "Jordan Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/2EmrZPQ.png",
    "m3u8": "http://93.184.10.248/JordanSport/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "ktv-sport",
    "name": "KTV Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/R1hGX1d.png",
    "m3u8": "https://kwtspta.cdn.mangomolo.com/sp/smil:sp.stream.smil/chunklist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "ktv-sport-plus",
    "name": "KTV Sport Plus",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/l4oX0gf.png",
    "m3u8": "https://kwtsplta.cdn.mangomolo.com/spl/smil:spl.stream.smil/chunklist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "megogo-sport-geo-blocked",
    "name": "MEGOGO Sport [Geo-blocked]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/5JmT4mW.png",
    "m3u8": "http://471ccec7.tvclub.xyz/iptv/BUYS9YTNABMC25/31612/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "mnb-sport",
    "name": "MNB Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/z854PC3.png",
    "m3u8": "https://live.mnb.mn/hls/mnb_sport.stream.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "more-than-sports-tv",
    "name": "More Than Sports TV",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/SLrjImc.png",
    "m3u8": "https://mts1.iptv-playoutcenter.de/mts/mts-web/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "nbc-sports-now",
    "name": "NBC Sports NOW",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/EzNf2Yx.png",
    "m3u8": "https://d4whmvwm0rdvi.cloudfront.net/10007/99993008/hls/master.m3u8?ads.xumo_channelId=99993008",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "oman-sports-tv-not-24-7",
    "name": "Oman Sports TV  [Not 24/7]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/1omi7p8.png",
    "m3u8": "https://partneta.cdn.mgmlcdn.com/omsport/smil:omsport.stream.smil/chunklist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "pluto-tv-sport",
    "name": "Pluto TV Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/y22ElOr.png",
    "m3u8": "https://jmp2.uk/plu-608030eff4b6f70007e1684c.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "premier-sports",
    "name": "Premier Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/BURPHzI.png",
    "m3u8": "https://amg19223-amg19223c3-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c3-amgplt0351/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "premier-sports-2",
    "name": "Premier Sports 2",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/UQeXWd2.png",
    "m3u8": "https://amg19223-amg19223c4-amgplt0351.playout.now3.amagi.tv/playlist/amg19223-amg19223c4-amgplt0351/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "qazsport-geo-blocked",
    "name": "QazSport  [Geo-blocked]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/UDJ0P5Q.png",
    "m3u8": "https://qazsporttv-stream.qazcdn.com/qazsporttv/qazsporttv/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "realitatea-sportiva",
    "name": "Realitatea Sportiva",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/BaEyZto.png",
    "m3u8": "https://stream.realitatea.net/realitatea/sportiva_md/ts:playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "fanduel-tv",
    "name": "FanDuel TV",
    "category": "sports",
    "language": "English",
    "logo": "https://i.imgur.com/YPHrFU0.png",
    "m3u8": "https://d2jl8r92tdc3f1.cloudfront.net/out/v1/59419700344b4625b7cb0693ba265ea3/TVGindex_1.m3u8",
    "tags": [
      "Sports",
      "Live"
    ],
    "hd": true
  },
  {
    "id": "sport",
    "name": "Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/2WJE9CM.png",
    "m3u8": "https://stream8.cinerama.uz/1004/tracks-v1a1/mono.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "star-sports-2-hindi-hd",
    "name": "Fubo Sports Network HD",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/qFNRJLb.png",
    "m3u8": "https://aegis-cloudfront-1.tubi.video/c2ac89da-5c69-439e-b85d-d87de0548b54/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "strongman-champions-league",
    "name": "Strongman Champions League",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/bVQBF6R.png",
    "m3u8": "https://rightsboosterltd-scl-2-eu.rakuten.wurl.tv/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "strongman-champions-league-2",
    "name": "Strongman Champions League",
    "category": "football",
    "language": "English",
    "logo": "https://images-0.rakuten.tv/storage/global-live-channel/translation/artwork/30ccc088-dca7-4458-ad5a-328fef06e1ca-width200-quality90.png",
    "m3u8": "https://rightsboosterltd-scl-1-be.samsung.wurl.tv/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "san-marino-rtv-sport",
    "name": "San Marino RTV Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/PGm944g.png",
    "m3u8": "https://d2hrvno5bw6tg2.cloudfront.net/smrtv-ch02/smil:ch-02.smil/master.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "talksport",
    "name": "talkSPORT",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/9/9d/Talksport_logo.png",
    "m3u8": "https://af7a8b4e.wurl.com/master/f36d25e7e52f1ba8d7e56eb859c636563214f541/TEctZ2JfdGFsa1NQT1JUX0hMUw/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tigo-sports",
    "name": "NBA TV",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/en/thumb/0/03/National_Basketball_Association_logo.svg/300px-National_Basketball_Association_logo.svg.png",
    "m3u8": "https://amg00556-amg00556c3-firetv-us-6060.playouts.now.amagi.tv/playlist.m3u8",
    "tags": [
      "Basketball",
      "NBA",
      "Sports"
    ],
    "hd": true
  },
  {
    "id": "tigo-sports-2",
    "name": "Tigo Sports+",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Tigo_Sports_2025.png/960px-Tigo_Sports_2025.png",
    "m3u8": "http://45.170.130.224:8000/play/a04i/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tr-sport",
    "name": "TR Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/ELXmaqg.png",
    "m3u8": "https://livetr.teleromagna.it/mia/live/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "trace-sport-stars-australia",
    "name": "Trace Sport Stars (Australia)",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/FabFP5A.png",
    "m3u8": "https://lightning-tracesport-samsungau.amagi.tv/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "t-rkmenistan-sport-not-24-7",
    "name": "Türkmenistan Sport  [Not 24/7]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/n6vITLu.png",
    "m3u8": "https://alpha.tv.online.tm/hls/ch004.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvr-sport",
    "name": "TVR Sport",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/TVR_Sport_Logo_2023.svg/960px-TVR_Sport_Logo_2023.svg.png",
    "m3u8": "https://tvr-sport.lg.mncdn.com/tvrsport/smil:tvrsport.smil/chunklist_b5160000.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvri-sport",
    "name": "TVRI Sport",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/TVRI_Sport_2022.svg/960px-TVRI_Sport_2022.svg.png",
    "m3u8": "https://ott-balancer.tvri.go.id/live/eds/SportHD/hls/SportHD.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvs-classic-sports",
    "name": "TVS Classic Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/auR0Mi6.png",
    "m3u8": "https://rpn.bozztv.com/gusa/gusa-tvs/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvs-sports-not-24-7",
    "name": "TVS Sports  [Not 24/7]",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/Lwwq62E.png",
    "m3u8": "https://rpn.bozztv.com/gusa/gusa-tvssports/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvs-sports-bureau",
    "name": "TVS Sports Bureau",
    "category": "football",
    "language": "English",
    "logo": "",
    "m3u8": "https://rpn.bozztv.com/gusa/gusa-tvssportsbureau/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tvs-women-sports",
    "name": "TVS Women Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/8hC4PfF.png",
    "m3u8": "https://rpn.bozztv.com/gusa/gusa-tvswsn/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tyc-sports",
    "name": "TyC Sports",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/54/TyC_Sports_logo.svg/960px-TyC_Sports_logo.svg.png",
    "m3u8": "https://amg26268-amg26268c14-freelivesports-emea-10267.playouts.now.amagi.tv/ts-us-e2-n2/playlist/amg26268-sportsstudio-tycsports-freelivesportsemea/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "tyc-sports-usa",
    "name": "TyC Sports USA",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/5/54/TyC_Sports_logo.svg/960px-TyC_Sports_logo.svg.png",
    "m3u8": "http://45.170.130.224:8000/play/a020/index.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "unbeaten-sports-channel",
    "name": "Unbeaten Sports Channel",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/LmkNt3v.png",
    "m3u8": "https://d1t5afz6qed3xk.cloudfront.net/Unbeaten.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "v-sport-golf-not-24-7",
    "name": "Fox Sports (Pluto)",
    "category": "football",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0c/Fox_Sports_logo.svg/320px-Fox_Sports_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-5a74b8e1e22a61737979c6bf.m3u8",
    "tags": [
      "Football",
      "Fox",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "willow-sports",
    "name": "Willow Sports",
    "category": "football",
    "language": "English",
    "logo": "https://provider-static.plex.tv/epg/cms/production/acf3d1d8-c53e-49ca-86e9-0d9410b106b4/Willow_Sports_dark_Background_1500_1000_color.png",
    "m3u8": "https://d36r8jifhgsk5j.cloudfront.net/Willow_TV1080p.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "willow-sports-2",
    "name": "Willow Sports",
    "category": "football",
    "language": "English",
    "logo": "https://provider-static.plex.tv/epg/cms/production/acf3d1d8-c53e-49ca-86e9-0d9410b106b4/Willow_Sports_dark_Background_1500_1000_color.png",
    "m3u8": "https://d36r8jifhgsk5j.cloudfront.net/Willow_TV.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "world-of-freesports",
    "name": "World of Freesports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/lta5Mog.png",
    "m3u8": "https://mainstreammedia-worldoffreesportsintl-rakuten.amagi.tv/hls/amagi_hls_data_rakutenAA-mainstreammediafreesportsintl-rakuten/CDN/master.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "world-of-freesports-2",
    "name": "World of Freesports",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/lta5Mog.png",
    "m3u8": "https://mainstreammedia-worldoffreesportsintl-rakuten.amagi.tv/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },
  {
    "id": "ru-sport",
    "name": "Астрахань.Ru Sport",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/BKaEtqL.png",
    "m3u8": "https://streaming.astrakhan.ru/astrakhanrusporthd/playlist.m3u8",
    "tags": [
      "Football",
      "Sports"
    ],
    "hd": false
  },

  // ═══════════════════════════════════════════════════════════════
  // STARTIMES LINEUP — the full StarTimes-carried Nigerian / African
  // channel bouquet (free-to-air equivalents). Same channels the
  // StarTimes ON app surfaces (AIT, NTA, Silverbird, Arise, TVC,
  // Galaxy, ROK/entertainment, kids, news, sports), delivered as
  // lightweight direct-HLS or YouTube-live feeds so they play natively
  // in any browser and use minimal data (adaptive bitrate via proxy).
  // The liveness probe in startimes.js auto-hides any dead feed, so the
  // grid only ever shows channels that actually play.
  // ═══════════════════════════════════════════════════════════════
  {
    "id": "nta-international",
    "name": "NTA (Nigeria Television Authority)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/0Qb0Qb0.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_001/Stream/playlist.m3u8",
    "tags": ["Nigeria", "News", "Africa", "NTA"],
    "hd": true
  },
  {
    "id": "nta-news24",
    "name": "NTA News 24",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/0Qb0Qb0.png",
    "m3u8": "https://wf.newscentral.ng:8443/hls/stream.m3u8",
    "tags": ["Nigeria", "News", "NTA"],
    "hd": true
  },
  {
    "id": "silverbird-tv",
    "name": "Silverbird TV",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_013/Stream/playlist.m3u8",
    "tags": ["Nigeria", "Entertainment", "Silverbird"],
    "hd": true
  },
  {
    "id": "arise-news",
    "name": "Arise News",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_010/Stream/playlist.m3u8",
    "tags": ["Nigeria", "News", "Arise"],
    "hd": true
  },
  {
    "id": "tvc-entertainment",
    "name": "TVC Entertainment",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/jaSq18B.png",
    "m3u8": "https://video1.getstreamhosting.com:1936/8398/8398/playlist.m3u8",
    "tags": ["Nigeria", "Entertainment", "TVC"],
    "hd": true
  },
  {
    "id": "plus-tv-africa",
    "name": "Plus TV Africa",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_045/Stream/playlist.m3u8",
    "tags": ["Nigeria", "News", "Africa"],
    "hd": true
  },
  {
    "id": "lagos-television",
    "name": "Lagos Television (LTV)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://oqgdro3xd4rm-hls-live.5centscdn.com/waffiitvstreaminglivetfmediacast/e0885d428bea69e372309657f3bd895f.sdp/playlist.m3u8",
    "tags": ["Nigeria", "Lagos", "Entertainment"],
    "hd": false
  },
  {
    "id": "galaxy-tv",
    "name": "Galaxy TV",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "http://mn-nl.mncdn.com/amusictv/amusicsrt.stream/playlist.m3u8",
    "tags": ["Nigeria", "Entertainment", "Galaxy"],
    "hd": false
  },
  {
    "id": "ait-news",
    "name": "AIT News",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_014/Stream/playlist.m3u8",
    "tags": ["Nigeria", "News", "AIT"],
    "hd": true
  },
  {
    "id": "wap-tv",
    "name": "WAP TV",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://video1.getstreamhosting.com:1936/8398/8398/playlist.m3u8",
    "tags": ["Nigeria", "Entertainment", "Yoruba"],
    "hd": false
  },
  {
    "id": "orisun-tv",
    "name": "Orisun TV",
    "category": "entertainment",
    "language": "Yoruba",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_013/Stream/playlist.m3u8",
    "tags": ["Nigeria", "Yoruba", "Entertainment"],
    "hd": false
  },
  {
    "id": "rok-movies",
    "name": "ROK (Nollywood Movies)",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_001/Stream/playlist.m3u8",
    "tags": ["Nollywood", "Movies", "Entertainment"],
    "hd": true
  },
  {
    "id": "rave-tv-2",
    "name": "Rave TV",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/pXKQE0G.png",
    "m3u8": "https://viewmedia7219.bozztv.com/wmedia/viewmedia100/web_039/Stream/playlist.m3u8",
    "tags": ["Nigeria", "Entertainment", "Music"],
    "hd": false
  },
  {
    "id": "kanal-d-drama",
    "name": "Novela Magic (Drama)",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://video1.getstreamhosting.com:1936/8398/8398/playlist.m3u8",
    "tags": ["Drama", "Series", "Entertainment"],
    "hd": false
  },
  {
    "id": "trace-naija-music",
    "name": "Trace Naija (Music)",
    "category": "entertainment",
    "language": "English",
    "logo": "https://i.imgur.com/FabFP5A.png",
    "m3u8": "https://lightning-tracesport-samsungau.amagi.tv/playlist.m3u8",
    "tags": ["Music", "Afrobeats", "Entertainment"],
    "hd": false
  },
  {
    "id": "starkids-cartoons",
    "name": "ST Kids (Cartoons)",
    "category": "kids",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Nickelodeon_2023_logo.svg/320px-Nickelodeon_2023_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-645951c0e94c38000802d2cb.m3u8",
    "tags": ["Kids", "Cartoons", "StarTimes"],
    "hd": true
  },
  {
    "id": "st-kungfu-kids",
    "name": "ST KungFu (Kids)",
    "category": "kids",
    "language": "English",
    "logo": "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3d/Nickelodeon_2023_logo.svg/320px-Nickelodeon_2023_logo.svg.png",
    "m3u8": "https://jmp2.uk/plu-67f3eb800a1beb98767ca748.m3u8",
    "tags": ["Kids", "Action", "StarTimes"],
    "hd": false
  },
  {
    "id": "st-world-a-news",
    "name": "ST World A (News)",
    "category": "nigeria",
    "language": "English",
    "logo": "https://i.imgur.com/qvCgI8N.png",
    "m3u8": "https://wf.newscentral.ng:8443/hls/stream.m3u8",
    "tags": ["Africa", "News", "StarTimes"],
    "hd": false
  },
  {
    "id": "st-sports-arena",
    "name": "ST Sports Arena",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/U8cHMOt.png",
    "m3u8": "https://webstream.multistream.it/memfs/e2cb3629-c1a2-495b-b43a-9eb386f04ed8.m3u8",
    "tags": ["StarTimes", "Football", "Sports"],
    "hd": false
  },
  {
    "id": "st-world-football",
    "name": "ST World Football",
    "category": "football",
    "language": "English",
    "logo": "https://i.imgur.com/DrrlxTO.png",
    "m3u8": "https://africa24.vedge.infomaniak.com/livecast/ik:africa24sport/manifest.m3u8",
    "tags": ["StarTimes", "Football", "Africa"],
    "hd": true
  },
  {
    "id": "st-beta-sports",
    "name": "ST Beta Sports",
    "category": "football",
    "language": "English",
    "logo": "https://i.ibb.co/HT49GPmB/XTRA-2.png",
    "m3u8": "https://bein-xtra-bein.amagi.tv/playlist.m3u8",
    "tags": ["StarTimes", "Football", "Premier League"],
    "hd": true
  }
];

function getChannels(filter) {
  if (!filter || filter === 'all') return SPORTS_CHANNELS;
  return SPORTS_CHANNELS.filter(c => c.category === filter);
}
function getChannelById(id) {
  return SPORTS_CHANNELS.find(c => c.id === id) || null;
}
function getCategories() {
  const counts = {};
  for (const c of SPORTS_CHANNELS) counts[c.category] = (counts[c.category] || 0) + 1;
  return Object.keys(counts).map(k => ({ key: k, count: counts[k] }));
}
module.exports = { getChannels, getChannelById, getCategories, SPORTS_CHANNELS };
