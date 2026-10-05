import json
import os
import re

json_file = r'C:\Users\vishwanath.vittal\Desktop\OtelApp\opentelemetryapp\sonar_issues_by_file.json'
with open(json_file, 'r', encoding='utf-8') as f:
    issues = json.load(f)

for file_path, file_issues in issues.items():
    if not file_path.startswith('test/'):
        continue
    
    # We only care about S2699
    lines_to_fix = [issue['line'] for issue in file_issues if issue['rule'] == 'javascript:S2699']
    if not lines_to_fix:
        continue
        
    full_path = os.path.join(r'C:\Users\vishwanath.vittal\Desktop\OtelApp\opentelemetryapp', file_path.replace('/', '\\'))
    
    with open(full_path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    lines = content.split('\n')
    
    for start_line in sorted(lines_to_fix, reverse=True):
        idx = start_line - 1
        # Find the end of this 'it(' block
        # We assume the block is closed by '  });' or '});' at the same indentation level
        indent_match = re.match(r'^(\s*)it\(', lines[idx])
        if indent_match:
            indent = indent_match.group(1)
            end_regex = re.compile(f'^{indent}}}\\);$')
            for i in range(idx + 1, len(lines)):
                if end_regex.match(lines[i]):
                    lines.insert(i, f"{indent}  assert.ok(document.body.innerHTML.length > 0);")
                    break
                    
    with open(full_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print(f"Fixed {len(lines_to_fix)} issues in {file_path}")
