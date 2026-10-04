export function labelGateFailures(results) {
 const failures=[];
 for(const [i,v] of results.views.entries()){
  for(const key of ['lost','overflow','shapeOverlap','edgeNodeOverlap','edgeLabelOverlap'])
   if(v[key]?.length)failures.push(i+':'+key);
  if(v.reachable!==v.nodeCount)failures.push(i+':reachable');
  if(!v.zoom?.length || v.zoom.some(z=>z.visible!==v.nodeCount))failures.push(i+':zoom visibility');
  if(!v.searches || ['resp','purged_headers','yield_requests','rewindable','TooManyRedirects'].some(q=>!(v.searches[q]>0)))failures.push(i+':search');
  if(Object.values(v.overview||{}).some(o=>!o.hidden||!o.restored||!o.exact))failures.push(i+':overview');
  if(v.resize?.failures?.length||v.resize?.searchMatches===0)failures.push(i+':resize');
  if(v.lateFont?.failures?.length)failures.push(i+':late font');
  if(!v.fontLoaded)failures.push(i+':production font');
 }
 if(results.completeness?.some(c=>!c.exact))failures.push('source completeness');
 return failures;
}
