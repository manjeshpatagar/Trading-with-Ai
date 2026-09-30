export type ClosedTrade = { id: string; entryTime: string; exitTime: string; symbol: string; side: string; entryPrice: number; exitPrice: number; quantity: number; marginUsed: number; grossPnl: number; entryBrokerage: number; exitBrokerage: number; brokerage: number; otherCharges: number; totalCharges: number; netPnl: number; netPnlPercent: number; exitReason: string; durationMinutes: number; chargesSource: string };
export type DailyTradeSummary = { date: string; openingBalance: number; closingBalance: number; totalTrades: number; wins: number; losses: number; grossProfit: number; grossLoss: number; brokerage: number; otherCharges: number; totalCharges: number; netPnl: number; winRate: number };
export type ClosedTradeReport = { range: { start: string; end: string }; summary: { openingBalance: number; closingBalance: number; totalTrades: number; winningTrades: number; losingTrades: number; breakevenTrades: number; grossProfit: number; grossLoss: number; brokerage: number; otherCharges: number; totalCharges: number; netPnl: number; winRate: number; averageProfit: number; averageLoss: number; totalMarginUsed: number }; daily: DailyTradeSummary[]; rows: ClosedTrade[]; allRows: ClosedTrade[]; pagination: { page: number; pageSize: number; total: number; pages: number } };

type ReportFonts = { regular: string; bold: string };
const money = (value: number) => value.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateTime = (value: string) => {
  const date = new Date(value);
  return [date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }), date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })];
};

export async function closedTradeDocument(report: ClosedTradeReport, fonts: ReportFonts) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
  pdf.addFileToVFS('ReportRegular.ttf', fonts.regular); pdf.addFont('ReportRegular.ttf', 'Report', 'normal');
  pdf.addFileToVFS('ReportBold.ttf', fonts.bold); pdf.addFont('ReportBold.ttf', 'Report', 'bold');
  pdf.setProperties({ title: 'Closed Trades - Trade History', author: 'QuantPulse', subject: 'Realized paper trade history including charges and net profit or loss' });
  const width=pdf.internal.pageSize.getWidth(), height=pdf.internal.pageSize.getHeight(), margin=20, inner=width-margin*2;
  const c={bg:'#08111f',panel:'#111b2e',panel2:'#0b1424',border:'#26364f',text:'#f8fafc',muted:'#8fa2bd',cyan:'#67e8f9',green:'#5ee6b6',red:'#fda4af',amber:'#fde68a'};
  const text=(value:string|string[],x:number,y:number,size=8,color=c.text,bold=false)=>{pdf.setFont('Report',bold?'bold':'normal');pdf.setFontSize(size);pdf.setTextColor(color);pdf.text(value,x,y)};
  const rect=(x:number,y:number,w:number,h:number,fill=c.panel)=>{pdf.setFillColor(fill);pdf.setDrawColor(c.border);pdf.setLineWidth(.5);pdf.roundedRect(x,y,w,h,5,5,'FD')};
  const header=(continued=false)=>{pdf.setFillColor(c.bg);pdf.rect(0,0,width,height,'F');text('QUANTPULSE',margin,24,7,c.cyan,true);text('Closed Trades · Trade History',margin,44,17,c.text,true);text(`${report.range.start} to ${report.range.end} · Asia/Kolkata${continued?' · Continued':''}`,margin,60,8,c.muted);text(`Generated ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}`,width-margin-190,43,8,c.muted);};
  header();
  const cards:[string,string,string][]=[
    ['BALANCE BEFORE',money(report.summary.openingBalance),c.text],['BALANCE AFTER',money(report.summary.closingBalance),c.cyan],['TOTAL TRADES',String(report.summary.totalTrades),c.text],['WINS / LOSSES',`${report.summary.winningTrades} / ${report.summary.losingTrades}`,c.text],
    ['GROSS PROFIT',money(report.summary.grossProfit),c.green],['GROSS LOSS',money(report.summary.grossLoss),c.red],['TOTAL CHARGES',money(report.summary.totalCharges),c.amber],['FINAL NET P&L',money(report.summary.netPnl),report.summary.netPnl>=0?c.green:c.red]
  ];
  const gap=7, cardW=(inner-gap*7)/8;
  cards.forEach(([label,value,color],i)=>{const x=margin+i*(cardW+gap);rect(x,75,cardW,50);text(label,x+8,91,6.5,c.muted,true);text(value,x+8,114,10,color,true)});
  text(`Win rate ${report.summary.winRate.toFixed(1)}%  ·  Brokerage ${money(report.summary.brokerage)}  ·  Other charges ${money(report.summary.otherCharges)}  ·  Margin used ${money(report.summary.totalMarginUsed)}`,margin,143,8,c.muted);

  const labels=['ENTRY / EXIT','STOCK / SIDE','PRICES','QTY / MARGIN','GROSS P&L','BROKERAGE','OTHER / TOTAL','NET P&L','EXIT'];
  const widths=[106,84,94,85,73,78,78,73,111].map(v=>v/782*inner);
  let y=158;
  const tableHeader=()=>{pdf.setFillColor('#040919');pdf.rect(margin,y,inner,27,'F');let x=margin;labels.forEach((label,i)=>{text(label,x+6,y+17,6.5,c.muted,true);x+=widths[i]});y+=27};
  const nextPage=()=>{pdf.addPage();header(true);y=76;tableHeader()};
  tableHeader();
  for(const [index,row] of report.allRows.entries()){
    const rowH=54;if(y+rowH>height-38)nextPage();
    if(index%2===0){pdf.setFillColor(c.panel2);pdf.rect(margin,y,inner,rowH,'F')}
    const [entryDate,entryClock]=dateTime(row.entryTime),[exitDate,exitClock]=dateTime(row.exitTime);
    const cells:string[][]=[
      [entryDate,entryClock,`Exit ${exitDate} ${exitClock}`],[row.symbol,row.side],[`Entry ${money(row.entryPrice)}`,`Exit ${money(row.exitPrice)}`],[`Qty ${row.quantity}`,money(row.marginUsed)],[money(row.grossPnl)],[money(row.brokerage),`Entry ${money(row.entryBrokerage)} · Exit ${money(row.exitBrokerage)}`],[money(row.otherCharges),`Total ${money(row.totalCharges)}`],[money(row.netPnl),`${row.netPnlPercent>=0?'+':''}${row.netPnlPercent.toFixed(2)}%`],[row.exitReason,`${row.durationMinutes} min`,row.chargesSource.startsWith('ESTIMATED')?'Estimated charges':'Broker charges']
    ];
    let x=margin;cells.forEach((parts,i)=>{let lineY=y+16;parts.forEach((part,j)=>{const pnl=i===4?row.grossPnl:i===7?row.netPnl:null;const color=pnl!==null?(pnl>=0?c.green:c.red):i===1&&j===1?(row.side==='BUY'?c.green:c.red):j?c.muted:c.text;text(pdf.splitTextToSize(part,widths[i]-11),x+6,lineY,j===0?7.5:6.2,color,j===0);lineY+=j===0?13:10});x+=widths[i]});
    y+=rowH;pdf.setDrawColor(c.border);pdf.line(margin,y,width-margin,y);
  }
  if(!report.allRows.length)text('No closed trades match the selected filters.',margin+8,y+30,10,c.muted);

  pdf.addPage();header();text('Daily account summary',margin,88,13,c.text,true);text('Opening and closing balances include each day’s realized net P&L after brokerage and charges.',margin,104,8,c.cyan);
  y=122;const dayLabels=['DATE','OPENING','CLOSING','TRADES','WINS','LOSSES','GROSS PROFIT','GROSS LOSS','BROKERAGE','OTHER','NET P&L','WIN RATE'];const dayWidths=[70,76,76,43,38,42,75,70,65,58,70,55].map(v=>v/738*inner);
  pdf.setFillColor('#040919');pdf.rect(margin,y,inner,28,'F');let dx=margin;dayLabels.forEach((label,i)=>{text(label,dx+5,y+18,6.3,c.muted,true);dx+=dayWidths[i]});y+=28;
  for(const [index,day] of report.daily.entries()){
    if(y+34>height-42){pdf.addPage();header(true);y=82}
    if(index%2===0){pdf.setFillColor(c.panel2);pdf.rect(margin,y,inner,34,'F')}
    const values=[day.date,money(day.openingBalance),money(day.closingBalance),String(day.totalTrades),String(day.wins),String(day.losses),money(day.grossProfit),money(day.grossLoss),money(day.brokerage),money(day.otherCharges),money(day.netPnl),`${day.winRate.toFixed(1)}%`];dx=margin;values.forEach((value,i)=>{const color=i===6?c.green:i===7?c.red:i===10?(day.netPnl>=0?c.green:c.red):i===2?c.cyan:c.text;text(pdf.splitTextToSize(value,dayWidths[i]-9),dx+5,y+21,7,color,i===0||i===2||i===10);dx+=dayWidths[i]});y+=34;pdf.setDrawColor(c.border);pdf.line(margin,y,width-margin,y)
  }
  const pages=pdf.getNumberOfPages();for(let page=1;page<=pages;page++){pdf.setPage(page);text('Realized paper trades · Values include brokerage and statutory charges',margin,height-15,6.5,c.muted);text(`QUANTPULSE · ${page} / ${pages}`,width-120,height-15,6.5,c.muted,true)}
  return {content:pdf.output('arraybuffer'),filename:`QuantPulse-Closed-Trades-${report.range.start}-to-${report.range.end}.pdf`,pageCount:pages};
}

let fontPromise:Promise<ReportFonts>|undefined;
async function loadFonts(){const base64=async(path:string)=>{const response=await fetch(path);if(!response.ok)throw new Error('Unable to load PDF fonts. Please try again.');const bytes=new Uint8Array(await response.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));return btoa(binary)};if(!fontPromise)fontPromise=Promise.all([base64('/fonts/report-regular.ttf'),base64('/fonts/report-bold.ttf')]).then(([regular,bold])=>({regular,bold})).catch(error=>{fontPromise=undefined;throw error});return fontPromise}
export async function downloadClosedTradeReport(report:ClosedTradeReport){const {content,filename}=await closedTradeDocument(report,await loadFonts());const url=URL.createObjectURL(new Blob([content],{type:'application/pdf'}));const link=document.createElement('a');link.href=url;link.download=filename;link.style.display='none';document.body.appendChild(link);try{link.click()}finally{link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),30_000)}}
