import json, sys, collections

S = sys.argv[1]
C = json.load(open(f"{S}/" + (sys.argv[3] if len(sys.argv) > 3 else "chrome152_full.json")))
O = json.load(open(f"{S}/" + (sys.argv[4] if len(sys.argv) > 4 else "oxide_full.json")))
detail = {"missing_interfaces": [], "extra_interfaces": [], "parent": [], "length": [],
          "missing": [], "extra": [], "shape": [], "window_missing": [], "window_extra": [],
          "window_shape": [], "namespaces": {}}

FIELDS = ("k", "e", "c", "w", "l", "g", "s")


def shape_diff(a, b):
    return {f: (a.get(f), b.get(f)) for f in FIELDS if a.get(f) != b.get(f)}


ci, oi = C["interfaces"], O["interfaces"]
detail["missing_interfaces"] = sorted(set(ci) - set(oi))
detail["extra_interfaces"] = sorted(set(oi) - set(ci))
for name in sorted(set(ci) & set(oi)):
    a, b = ci[name], oi[name]
    if a["parent"] != b["parent"]:
        detail["parent"].append((name, a["parent"], b["parent"]))
    if a["length"] != b["length"]:
        detail["length"].append((name, a["length"], b["length"]))
    for part in ("static", "proto"):
        am, bm = a[part], b[part]
        for k in sorted(set(am) - set(bm)):
            detail["missing"].append(f"{name}.{'prototype.' if part == 'proto' else ''}{k}")
        for k in sorted(set(bm) - set(am)):
            detail["extra"].append(f"{name}.{'prototype.' if part == 'proto' else ''}{k}")
        for k in sorted(set(am) & set(bm)):
            if am[k] and bm[k] and not k.startswith("@@"):
                sd = shape_diff(am[k], bm[k])
                if sd:
                    detail["shape"].append((f"{name}.{'prototype.' if part == 'proto' else ''}{k}", sd))

cw, ow = C["window"], O["window"]
detail["window_missing"] = sorted(set(cw) - set(ow))
detail["window_extra"] = sorted(set(ow) - set(cw))
for k in sorted(set(cw) & set(ow)):
    if cw[k] and ow[k]:
        sd = shape_diff(cw[k], ow[k])
        if sd:
            detail["window_shape"].append((k, sd))

for ns, a in C["namespaces"].items():
    b = O["namespaces"].get(ns)
    if not b:
        detail["namespaces"][ns] = "missing"
        continue
    detail["namespaces"][ns] = {
        "tag": (a["tag"], b["tag"]) if a["tag"] != b["tag"] else "ok",
        "missing": sorted(set(a["members"]) - set(b["members"])),
        "extra": sorted(set(b["members"]) - set(a["members"])),
    }

json.dump(detail, open(f"{S}/" + (sys.argv[5] if len(sys.argv) > 5 else "surface_detail.json"), "w"), indent=1)

print(f"interfaces: missing={len(detail['missing_interfaces'])} extra={len(detail['extra_interfaces'])} "
      f"parent_mismatch={len(detail['parent'])} ctor_length_mismatch={len(detail['length'])}")
print(f"members: missing={len(detail['missing'])} extra={len(detail['extra'])} shape_mismatch={len(detail['shape'])}")
print(f"window own: missing={len(detail['window_missing'])} extra={len(detail['window_extra'])} shape_mismatch={len(detail['window_shape'])}")
shape_kinds = collections.Counter(f for _, sd in detail["shape"] for f in sd)
print("shape mismatch by field:", dict(shape_kinds))
by_iface = collections.Counter(x.split(".")[0] for x in detail["missing"])
print("top missing by interface:", by_iface.most_common(25))
by_iface_x = collections.Counter(x.split(".")[0] for x in detail["extra"])
print("top extra by interface:", by_iface_x.most_common(15))
by_iface_s = collections.Counter(x[0].split(".")[0] for x in detail["shape"])
print("top shape mismatch by interface:", by_iface_s.most_common(15))
if len(sys.argv) > 2:
    for ns, v in detail["namespaces"].items():
        print("namespace", ns, v if isinstance(v, str) else {"tag": v["tag"], "missing": len(v["missing"]), "extra": len(v["extra"])})
