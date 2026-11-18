"""Builds tools/cities.json from the Natural Earth "populated places" dataset (public domain).

Usage:  python tools/cities.py path/to/ne_10m_populated_places_simple.geojson

Output: {region_code: [[name, lon, lat, population, is_capital], ...]} sorted by population.
The file is committed, so build_map.py does not need the download.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from countries import C, ATTACHED

# Natural Earth codes that belong to one of our regions under another code
REMAP = {'SOL': 'SOM', 'CYN': 'CYP', 'PSX': 'PSE', 'SAH': 'ESH', 'HKG': 'CHN', 'MAC': 'CHN'}

# well-known towns of very small nations that the dataset lacks: code -> [(name, lon, lat, pop)]
EXTRA = {
    'BHS': [('Freeport', -78.70, 26.53, 27000), ('Marsh Harbour', -77.06, 26.54, 6000), ("Cooper's Town", -77.52, 26.87, 800),
            ('Andros Town', -77.70, 24.70, 2000), ('George Town', -75.80, 23.50, 1500), ('West End', -78.97, 26.69, 13000)],
    'BRN': [('Kuala Belait', 114.19, 4.58, 30000), ('Seria', 114.32, 4.61, 30000), ('Tutong', 114.65, 4.80, 20000), ('Bangar', 115.07, 4.71, 2000)],
    'MNE': [('Nikšić', 18.94, 42.77, 56000), ('Herceg Novi', 18.53, 42.45, 17000), ('Bar', 19.10, 42.09, 17000), ('Budva', 18.84, 42.29, 19000),
            ('Kotor', 18.77, 42.42, 13000), ('Cetinje', 18.92, 42.39, 14000), ('Bijelo Polje', 19.75, 43.04, 15000)],
    'QAT': [('Al Rayyan', 51.42, 25.29, 600000), ('Al Wakrah', 51.60, 25.17, 100000), ('Al Khor', 51.50, 25.68, 30000),
            ('Dukhan', 50.78, 25.43, 5000), ('Umm Salal', 51.40, 25.41, 30000), ('Mesaieed', 51.55, 24.99, 20000)],
    'SVN': [('Maribor', 15.65, 46.55, 95000), ('Celje', 15.27, 46.23, 38000), ('Koper', 13.73, 45.55, 25000), ('Kranj', 14.36, 46.24, 37000),
            ('Novo Mesto', 15.17, 45.80, 23000), ('Murska Sobota', 16.17, 46.66, 11000)],
    'TLS': [('Baucau', 126.46, -8.47, 16000), ('Maliana', 125.22, -8.99, 8000), ('Suai', 125.32, -9.31, 6000), ('Lospalos', 127.00, -8.52, 7000)],
    'TTO': [('San Fernando', -61.47, 10.28, 55000), ('Chaguanas', -61.41, 10.52, 83000), ('Arima', -61.28, 10.63, 33000),
            ('Point Fortin', -61.68, 10.18, 20000), ('Scarborough', -60.73, 11.18, 4000)],
    'VUT': [('Luganville', 167.17, -15.51, 16000), ('Isangel', 169.27, -19.55, 1500), ('Lakatoro', 167.42, -16.10, 2000)],
    'GUF': [('Cayenne', -52.33, 4.94, 61000), ('Saint-Laurent-du-Maroni', -54.03, 5.50, 45000), ('Kourou', -52.65, 5.16, 26000),
            ('Matoury', -52.32, 4.85, 33000), ('Rémire-Montjoly', -52.28, 4.92, 24000), ('Maripasoula', -54.03, 3.64, 12000),
            ('Régina', -52.13, 4.32, 1000), ('Saint-Georges', -51.80, 3.89, 4000)],
    'ESH': [('Dakhla', -15.93, 23.68, 106000), ('Smara', -11.67, 26.74, 57000), ('Boujdour', -14.48, 26.13, 46000), ('Awsard', -14.30, 22.58, 2000)],
}


# corrections to the source data: (code, name) -> new name, and (code, name) -> new code
RENAME = {('AZE', 'Stepanakert'): 'Xankəndi'}
RECODE = {('AZE', 'Kapan'): 'ARM'}   # Kapan is a town in Armenia, the dataset files it under Azerbaijan


def main(path):
    feats = json.load(open(path, encoding='utf-8'))['features']
    valid = set(C) | set(ATTACHED)
    out = {}
    for f in feats:
        p = f['properties']
        code = REMAP.get(p['adm0_a3'], p['adm0_a3'])
        if code not in valid:
            continue
        lon, lat = f['geometry']['coordinates'][:2]
        name = RENAME.get((code, p['name']), p['name'])
        code = RECODE.get((code, p['name']), code)
        out.setdefault(code, []).append([name,round(lon, 3), round(lat, 3), int(p['pop_max'] or 0), int(p['adm0cap'] or 0), p['adm1name'] or ''])
    for code, rows in EXTRA.items():
        have = {r[0].lower() for r in out.get(code, [])}
        for n, lon, lat, pop in rows:
            if n.lower() not in have:
                out.setdefault(code, []).append([n, lon, lat, pop, 0, ''])
    for rows in out.values():
        rows.sort(key=lambda r: -r[3])
    json.dump(out, open(os.path.join(HERE, 'cities.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('regions with cities:', len(out), 'cities:', sum(len(v) for v in out.values()))
    print('no cities:', sorted(c for c in list(C) + list(ATTACHED) if c not in out))


if __name__ == '__main__':
    main(sys.argv[1])
