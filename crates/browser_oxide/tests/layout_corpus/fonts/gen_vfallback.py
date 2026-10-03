import json,sys
S=sys.argv[1] if len(sys.argv)>1 else '.'
ranges=json.load(open(f'{S}/ranges_final.json'))
ranges['han']=[0x4E00,0x9FFF,0x4E00]
ranges['han_extA']=[0x3400,0x4DBF,0x3400]
ranges['han_compat']=[0xF900,0xFAFF,0xF900]
for k in ('han_ext_b','han_ext_b_zh','private','pua_apple'): ranges.pop(k,None)
probe=json.load(open(f'{S}/pf_out5.json'))
fit=json.load(open(f'{S}/fit_ratios.json'))
dots=json.load(open(f'{S}/dot_ratios.json'))
classes=['Arial','Helvetica','Times','Menlo','system-ui']
own={'Arial':'Arial','Helvetica':'Helvetica','Times':'Times','Menlo':'Menlo','system-ui':'.SF NS'}
langs=['','ja','ko','zh-CN','zh-TW']
table={'蘋方-簡':0,'Apple Color Emoji':1}
vertical_named={'Times':'times','Helvetica':'helvetica'}
cell={}
for x in probe:
    cell[(x['id'],x['family'],x['lang'])]=x['fonts'][0].split('|')[0]
def metrics_of(name):
    if name in table: return ('Table',table[name])
    if name in vertical_named: return ('Named',vertical_named[name])
    if name.startswith('.'):
        r=dots.get(name)
        if not r or (r['A']==0 and r['D']==0): return None
        return ('Union',r['A'],r['D'])
    f=fit.get(name)
    if f is None: raise SystemExit('no fit for '+name)
    return ('Ratio',f['asc'],f['desc'],f['gap'])
# order ranges by width then start
order=sorted(ranges.items(),key=lambda kv:(kv[1][1]-kv[1][0],kv[1][0]))
fonts=[];index={}
def font_index(name):
    m=metrics_of(name)
    if m is None: return 255
    key=(name,)
    if name not in index:
        index[name]=len(fonts);fonts.append((name,m))
    return index[name]
choice=[]
for c in classes:
    rows=[]
    for k,(s,e,cp) in order:
        row=[]
        for l in langs:
            n=cell[(k,c,l)]
            row.append(255 if n==own[c] else font_index(n))
        rows.append(row)
    choice.append(rows)
out=[]
out.append('//! Generated from measurements of Chrome on macOS (tests/layout_corpus/fonts/): which font Chrome\n//! falls back to for a character the primary font lacks, and that font\'s vertical metrics.\n')
out.append('use super::Font;\n')
out.append('pub(super) const BLOCKS: &[(u32, u32)] = &[\n'+''.join(f'    (0x{s:04X}, 0x{e:04X}),\n' for k,(s,e,cp) in order)+'];\n')
def fnum(v):
    t=f'{float(v):.5f}'.rstrip('0')
    return t+'0' if t.endswith('.') else t
fl=[]
for name,m in fonts:
    if m[0]=='Ratio': fl.append(f'    Font::Ratio({fnum(m[1])}, {fnum(m[2])}, {fnum(m[3])}),')
    elif m[0]=='Union': fl.append(f'    Font::Union({fnum(m[1])}, {fnum(m[2])}),')
    elif m[0]=='Table': fl.append(f'    Font::Table({m[1]}),')
    else: fl.append(f'    Font::Named("{m[1]}"),')
    fl[-1]+=f' // {index[name]}'
out.append('pub(super) const FONTS: &[Font] = &[\n'+'\n'.join(fl)+'\n];\n')
nb=len(order)
out.append(f'pub(super) const NONE: u8 = 255;\n')
out.append(f'/// Per primary font (Arial, Helvetica, Times, Menlo, system-ui), per block of `BLOCKS`, per language\n/// (none, ja, ko, zh-CN, zh-TW): an index into `FONTS`.\n')
out.append(f'pub(super) const CHOICE: [[[u8; 5]; {nb}]; 5] = [\n')
for rows in choice:
    out.append('    [\n')
    for row in rows: out.append('        ['+', '.join(str(v) for v in row)+'],\n')
    out.append('    ],\n')
out.append('];\n')
open(f'{S}/vfallback_data.rs','w').write(''.join(out))
print(len(fonts),'fonts',nb,'blocks')
for i,(n,m) in enumerate(fonts): print(i,n,m)
