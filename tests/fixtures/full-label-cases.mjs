// Independent source oracle: never derived from FlowchartIR/GraphIR labels.
const id = 'unbroken_identifier_'.repeat(18);
const arg = '"escaped \\"quote\\" < > ... _.-(),:"';
const call = 'call_' + id + '(' + arg + ')';
export const cases = [
  {name:'for',prefix:'for_header_',source:'def sample():\n    for item in '+id+':\n        pass\n',expected:'for item in '+id},
  {name:'with',prefix:'with_',source:'def sample():\n    with '+call+' as resource:\n        pass\n',expected:call+' as resource'},
  {name:'return',prefix:'return_',source:'def sample():\n    return '+call+'\n',expected:'return '+call},
  {name:'ternary-true',prefix:'ternary_true_',source:'def sample():\n    target = '+call+' if check else alternative\n',expected:'target = '+call},
  {name:'ternary-false',prefix:'ternary_false_',source:'def sample():\n    target = first if check else '+call+'\n',expected:'target = '+call},
  {name:'higher-order-assignment',prefix:'assign_hof_',source:'def sample():\n    result = map(transform_'+id+', items)\n',expected:'result = map(transform_'+id+', items)'},
  {name:'multiline',prefix:'stmt_',source:'def sample():\n    value = (\n        '+arg+',\n        "'+id+'",\n        "fourth",\n        "fifth")\n',expected:'value = (\n        '+arg+',\n        "'+id+'",\n        "fourth",\n        "fifth")'},
];
export const layoutText = cases.map(c=>c.expected).join('\n');
