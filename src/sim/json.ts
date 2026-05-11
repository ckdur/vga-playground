export class JSONParseError extends Error {}

export interface JSONNode {
  type: string;
  text: string | null;
  children: JSONNode[];
  attrs: { [id: string]: string };
  obj: any;
}

export type JSONVisitFunction = (node: JSONNode) => any;

function escapeXML(s: string): string {
  if (s.indexOf('&') >= 0) {
    return s
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  } else {
    return s;
  }
}

export function parseJSONPoorly(
  s: string,
  openfn?: JSONVisitFunction,
  closefn?: JSONVisitFunction,
): JSONNode {

  let obj = JSON.parse(s) as Record<string, any>;
  if (!obj.modulesp) {
      throw new Error("No modulesp in the json");
  }
  const stack: JSONNode[] = [];
  let top: JSONNode | undefined;

  function closetop() {
    top = stack.pop();
    if (top == null) throw new JSONParseError('mismatch close tag: ');
    if (closefn) {
      top.obj = closefn(top);
    }
    if (stack.length == 0) throw new JSONParseError('close tag without open: ');
    stack[stack.length - 1].children.push(top);
  }
  
  // A record to keep what are the interations (IN ORDER)
  const priority: string[] = ["miscsp", "filesp", "modulesp", "argsp", "varsp",
    "scopep", "stmtsp", "typesp", "exprp", "lhsp", "rhsp", 
    "fromp", "bitp", "condp", "thensp", "elsesp", "attrsp"];

  function iterate_object(o: Record<string, any>) {
    // Extract attrs
    const labels = Object.keys(o);
    var attrs: Record<string, string> = {};
    for (const label of labels) {
      if (!Array.isArray(o[label])) {
        attrs[label] = String(o[label]);
      }
    }

    //console.log(o["type"])
    // Create the node as-is
    var node = { type: o["type"].toLowerCase(), text: null, children: [], attrs: attrs, obj: null };
    stack.push(node);
    if(openfn) {
      node.obj = openfn(node)
    }

    function just_push_elem(rec: string) {
      const elemp = o[rec];
      if(!elemp || elemp.length == 0) {
        throw new JSONParseError(`${rec} is empty`);
      }
      iterate_object(elemp[0]);
    }

    function push_as_begin(rec: string) {
      const elemp = o[rec];
      if(elemp && elemp.length > 0) {
        var elemp_node = { type: "begin", text: null, children: [], attrs: {}, obj: null };
        stack.push(elemp_node);
        if(openfn) {
          elemp_node.obj = openfn(elemp_node)
        }
        elemp.forEach((o2: Record<string, any>) => {iterate_object(o2)});
        closetop()
      }
    }

    // Special cases for IF
    if(o["type"] == "IF") {
      just_push_elem("condp")
      // treat the other ones as begin
      push_as_begin("thensp")
      push_as_begin("elsesp")
    }
    else if(o["type"] == "COND") {
      just_push_elem("condp")
      just_push_elem("thenp")
      just_push_elem("elsep")
    }
    else {
      for (const p of priority) { 
        const iobj = o[p]
        if(Array.isArray(iobj)) { // An identifiable type to just iterate downwards
          iobj.forEach((o2: Record<string, any>) => {
            o2["JSONfrom"] = p
            iterate_object(o2)
          });
        }
      }
      // Process everything that is not inside of the priority list
      for (const p of Object.keys(o)) {
        const iobj = o[p]
        if(!priority.includes(p) && Array.isArray(iobj)) { // Other iterables
          iobj.forEach((o2: Record<string, any>) => {
            o2["JSONfrom"] = p
            iterate_object(o2)
          });
        }
      }
    }

    closetop()
  }
  var node = { type: "GLOBAL", text: null, children: [], attrs: {}, obj: null };
  stack.push(node);
  iterate_object(obj)

  if (stack.length != 1) throw new JSONParseError('tag not closed');
  if (stack[0].type != 'GLOBAL') throw new JSONParseError('GLOBAL needs to be first element');
  if (!top) throw new JSONParseError('no top');
  return top;
}
