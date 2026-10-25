import json, sys
for r in sys.argv[1:]:
    d = json.load(open(f'results/{r}/result.json'))
    print('===', r, d.get('error'))
    print(json.dumps({k: v for k, v in d['init'].items() if k != 'create_engine_marks'}))
    for k, v in d['perf'].items():
        if isinstance(v, dict) and 'frame_ms' in v:
            print(k, 'frame', v['frame_ms']['median'], v['frame_ms']['p95'], 'cpu', json.dumps({a: (b['median'], b['p95']) for a, b in v.items() if a.startswith('cpu') and isinstance(b, dict)}))
        else:
            print(k, json.dumps(v))
    print(json.dumps(d['info']))
