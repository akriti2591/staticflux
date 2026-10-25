import re, sys
for p in sys.argv[1:]:
    s = open(p).read()
    s = re.sub(r"<<<<<<< [^\n]*\n(.*?)(?:\|\|\|\|\|\|\| [^\n]*\n.*?)?=======\n(.*?)>>>>>>> [^\n]*\n",
               lambda m: m.group(1).rstrip('\n') + "\n\n" + m.group(2), s, flags=re.S)
    open(p, 'w').write(s)
    print(p, 'markers left:', len(re.findall(r'^(<<<<<<<|>>>>>>>)', s, flags=re.M)))
import json
for p in sys.argv[1:]:
    if p.endswith('.json'):
        try: json.load(open(p)); print(p, 'valid JSON')
        except Exception as e: print(p, 'INVALID JSON:', e)
