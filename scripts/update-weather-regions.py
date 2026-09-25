import hashlib
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(sys.argv[1]) if len(sys.argv) > 1 else None
SOURCES = {
    'area.json': 'https://www.jma.go.jp/bosai/common/const/area.json',
    'forecast_area.json': 'https://www.jma.go.jp/bosai/forecast/const/forecast_area.json',
    'week_area.json': 'https://www.jma.go.jp/bosai/forecast/const/week_area.json',
    'week_area05.json': 'https://www.jma.go.jp/bosai/forecast/const/week_area05.json',
    'amedastable.json': 'https://www.jma.go.jp/bosai/amedas/const/amedastable.json',
    'muni.js': 'https://maps.gsi.go.jp/js/muni.js',
    'forecast.html': 'https://www.jma.go.jp/bosai/forecast/',
}
raw = {name: (CACHE / name).read_bytes() if CACHE else urllib.request.urlopen(url, timeout=30).read() for name, url in SOURCES.items()}
area, forecast, week, week05, stations = [json.loads(raw[n]) for n in list(SOURCES)[:5]]
ids = 'hokkaido aomori iwate miyagi akita yamagata fukushima ibaraki tochigi gunma saitama chiba tokyo kanagawa niigata toyama ishikawa fukui yamanashi nagano gifu shizuoka aichi mie shiga kyoto osaka hyogo nara wakayama tottori shimane okayama hiroshima yamaguchi tokushima kagawa ehime kochi fukuoka saga nagasaki kumamoto oita miyazaki kagoshima okinawa'.split()
capitals = '札幌市 青森市 盛岡市 仙台市 秋田市 山形市 福島市 水戸市 宇都宮市 前橋市 さいたま市 千葉市 千代田区 横浜市 新潟市 富山市 金沢市 福井市 甲府市 長野市 岐阜市 静岡市 名古屋市 津市 大津市 京都市 大阪市 神戸市 奈良市 和歌山市 鳥取市 松江市 岡山市 広島市 山口市 徳島市 高松市 松山市 高知市 福岡市 佐賀市 長崎市 熊本市 大分市 宮崎市 鹿児島市 那覇市'.split()
municipalities = []
for pref, pref_name, code, name in re.findall(r"=\s*'(\d+),([^,]+),(\d+),([^']+)';", raw['muni.js'].decode()):
    municipalities.append({'code': code.zfill(5), 'name': name.replace('　', ''), 'prefecture': pref_name, 'prefectureId': ids[int(pref)-1]})
by_name = {(m['prefectureId'], m['name']): m for m in municipalities}
missing = []
for m in municipalities:
    subareas = sorted(k for k in area['class20s'] if k[:5] == m['code'])
    if not subareas and '市' in m['name']:
        parent = by_name.get((m['prefectureId'], m['name'].split('市')[0] + '市'))
        if parent:
            subareas = sorted(k for k in area['class20s'] if k[:5] == parent['code'])
    if not subareas:
        subareas = sorted(k for k,v in area['class20s'].items() if k[:2] == m['code'][:2] and v['name'].startswith(m['name']))
    if not subareas and m['code'] in {'01695','01696','01697','01698','01699','01700'}:
        m['unavailable'] = 'この市区町村に対応する気象庁の予報区域がありません。'
        continue
    if not subareas:
        missing.append(m); continue
    chosen = subareas[0]
    if area['class20s'][chosen]['name'] == m['name']:
        m['code'] = chosen[:5]
    class15 = area['class20s'][chosen]['parent']
    class10 = area['class15s'][class15]['parent']
    office = area['class10s'][class10]['parent']
    mapping = next((x for x in forecast[office] if x['class10'] == class10), None)
    if not mapping:
        missing.append({'missingForecast': m, 'class10': class10}); continue
    station = next(code for code in mapping['amedas'] if code in stations)
    m.update({'class20': chosen, 'forecastAreaCode': class10, 'forecastAreaName': area['class10s'][class10]['name'], 'officeCode': office,
              'stationId': station, 'stationName': stations[station]['kjName'], 'representativeArea': len(subareas)>1})
if missing:
    print(json.dumps(missing, ensure_ascii=False)); raise SystemExit('Unmapped municipalities')
prefectures = []
for i, (id, capital) in enumerate(zip(ids, capitals)):
    m = by_name[(id, capital)]
    prefectures.append({'id': id, 'name': m['prefecture'], 'representativeCode': m['code']})
result = {'prefectures': prefectures, 'municipalities': municipalities, 'weekly': week, 'weekly05': week05}
out = ROOT / 'src/main/services/weather/data/regions.json'
out.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
(ROOT / 'src/main/services/weather/data-sources.json').write_text(json.dumps({n:{'url':url, 'sha256': hashlib.sha256(raw[n]).hexdigest()} for n,url in SOURCES.items()},indent=2)+'\n')
code_block = re.search(r'100:\[.*?\}', raw['forecast.html'].decode()).group(0)
weather_codes = json.loads('{' + re.sub(r'(\d+):', r'"\1":', code_block))
(out.parent / 'weather-codes.json').write_text(json.dumps({key: value[3] for key, value in weather_codes.items()}, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f'{len(prefectures)} prefectures, {len(municipalities)} municipalities')
