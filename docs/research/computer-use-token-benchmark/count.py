import hashlib
import importlib.metadata
import json
from pathlib import Path
import tiktoken

root = Path(__file__).resolve().parent
encodings = {name: tiktoken.get_encoding(name) for name in ['o200k_base', 'cl100k_base']}

def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

rows = []
for arm in ['own', 'upstream']:
    tools = json.loads((root / f'{arm}.tools.json').read_text())
    surfaces = {
        'mcp_tools_list': {'tools': tools},
        'openai_functions': [{'type': 'function', 'function': {'name': tool['name'], 'description': tool.get('description', ''), 'parameters': tool['inputSchema']}} for tool in tools],
    }
    for surface, value in surfaces.items():
        text = packed(value)
        rows.append({'arm': arm, 'surface': surface, 'tool_count': len(tools), 'characters': len(text), 'utf8_bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest(), 'tokens': {name: len(enc.encode(text)) for name, enc in encodings.items()}})
result = {'measurement': 'local exact tokenization of canonical JSON; NOT provider usage or end-to-end task tokens', 'tiktoken_version': importlib.metadata.version('tiktoken'), 'serialization': 'UTF-8, ensure_ascii=False, sort_keys=True, separators=(comma,colon)', 'rows': rows}
(root / 'schema-results.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
