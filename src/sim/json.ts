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
  const priority: string[] = ["modulesp", "stmtsp", "scopep", "stmtsp", "exprp", "rhsp", "lhsp", "fromp", "bitp", "condp", "thensp", "elsesp"];

  function iterate_object(o: Record<string, any>) {
    // Extract attrs
    const labels = Object.keys(o);
    var attrs: Record<string, string> = {};
    for (const label of labels) {
      if (!Array.isArray(o[label])) {
        attrs[label] = String(o[label]);
      }
    }

    console.log(o["type"])
    // Create the node as-is
    var node = { type: o["type"].toLowerCase(), text: null, children: [], attrs: attrs, obj: null };
    stack.push(node);
    if(openfn) {
      node.obj = openfn(node)
    }

    for (const p of priority) { 
      const iobj = o[p]
      if(Array.isArray(iobj)) { // An identifiable type to just iterate downwards
        iobj.forEach((o2: Record<string, any>) => {iterate_object(o2)})
      }
    }
    closetop()
  }
  iterate_object(obj)

  if (stack.length != 1) throw new JSONParseError('tag not closed');
  if (stack[0].type != '?xml') throw new JSONParseError('?xml needs to be first element');
  if (!top) throw new JSONParseError('no top');
  return top;
}
