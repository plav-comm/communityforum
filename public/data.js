/* Town Hall Meetings — sample video library.
   Every entry below is a REAL, publicly posted local government meeting video on YouTube.
   Location, governing body, date and runtime reflect the actual recording.
   Topic tags are illustrative editorial metadata for this prototype. */

const TIERS = [
  { id: 'xs', label: 'Under 10,000' },
  { id: 'sm', label: '10,000 – 50,000' },
  { id: 'md', label: '50,000 – 150,000' },
  { id: 'lg', label: '150,000 – 500,000' },
  { id: 'xl', label: '500,000+' }
];

const TOPICS = [
  { id: 'budget', label: 'Budget & Taxes' },
  { id: 'housing', label: 'Housing & Zoning' },
  { id: 'safety', label: 'Public Safety' },
  { id: 'schools', label: 'Schools & Education' },
  { id: 'infra', label: 'Infrastructure' },
  { id: 'water', label: 'Water & Environment' },
  { id: 'parks', label: 'Parks & Recreation' },
  { id: 'gov', label: 'Open Government' }
];

const VIDEOS = [
  {
    yt: '0-tISiCsmZw',
    title: 'City Council Regular Meeting 2026-21',
    org: 'City of Palm Bay',
    city: 'Palm Bay', county: 'Brevard County', state: 'Florida', sc: 'FL',
    tier: 'md', pop: '~120,000',
    body: 'City Council', date: '2026-08-20', dur: 22334,
    topics: ['budget', 'infra', 'safety'],
    blurb: 'Full regular session of the Palm Bay City Council from Council Chambers on Malabar Road SE.'
  },
  {
    yt: 'GvuFLziqUmc',
    title: 'Select Board: August 24, 2026',
    org: 'Chelmsford Telemedia (CTM)',
    city: 'Chelmsford', county: 'Middlesex County', state: 'Massachusetts', sc: 'MA',
    tier: 'sm', pop: '~36,000',
    body: 'Select Board', date: '2026-08-24', dur: 7500,
    topics: ['gov', 'budget', 'parks'],
    blurb: 'Live coverage of the Select Board from the official municipal television station of Chelmsford.'
  },
  {
    yt: 'RYtkLLIG1LM',
    title: 'County Commission Meeting 8/20/26',
    org: 'Glynn County, Georgia',
    city: 'Brunswick', county: 'Glynn County', state: 'Georgia', sc: 'GA',
    tier: 'md', pop: '~85,000',
    body: 'County Commission', date: '2026-08-20', dur: 6573,
    topics: ['housing', 'budget', 'water'],
    blurb: 'Board of Commissioners convenes at 6:00 p.m. for its second August session.'
  },
  {
    yt: 'gVVVLRPK1bA',
    title: 'City Council Meeting | August 18, 2026',
    org: 'City of Columbia, SC',
    city: 'Columbia', county: 'Richland County', state: 'South Carolina', sc: 'SC',
    tier: 'md', pop: '~140,000',
    body: 'City Council', date: '2026-08-18', dur: 10800,
    topics: ['gov', 'budget', 'housing'],
    blurb: 'Regular council session, posted alongside the city’s new public meeting portal.'
  },
  {
    yt: 'fzcBRWsAGI4',
    title: 'City Council Meeting - August 18, 2026',
    org: 'City of Shelton, WA',
    city: 'Shelton', county: 'Mason County', state: 'Washington', sc: 'WA',
    tier: 'sm', pop: '~11,000',
    body: 'City Council', date: '2026-08-18', dur: 7580,
    topics: ['infra', 'water', 'budget'],
    blurb: 'Small-city council proceedings with agendas, packets and minutes published by the city.'
  },
  {
    yt: 'z0WF0HxXDP4',
    title: 'City Council Meeting - August 11, 2026',
    org: 'City of Lubbock',
    city: 'Lubbock', county: 'Lubbock County', state: 'Texas', sc: 'TX',
    tier: 'lg', pop: '~265,000',
    body: 'City Council', date: '2026-08-11', dur: 3673,
    topics: ['budget', 'safety'],
    blurb: 'Regular meeting of the Lubbock City Council opened by the mayor.'
  },
  {
    yt: 'UuBPS0uteZI',
    title: 'City Council Meeting - 08-10-2026',
    org: 'City of Texarkana, Texas',
    city: 'Texarkana', county: 'Bowie County', state: 'Texas', sc: 'TX',
    tier: 'sm', pop: '~36,000',
    body: 'City Council', date: '2026-08-10', dur: 5541,
    topics: ['infra', 'housing'],
    blurb: 'Regular Monday-evening meeting of the Texarkana, Texas City Council.'
  },
  {
    yt: 's04mQ1jvjJo',
    title: 'County Commission Meeting August 6, 2026',
    org: 'Glynn County, Georgia',
    city: 'Brunswick', county: 'Glynn County', state: 'Georgia', sc: 'GA',
    tier: 'md', pop: '~85,000',
    body: 'County Commission', date: '2026-08-06', dur: 2204,
    topics: ['gov', 'parks'],
    blurb: 'A short August session of the Glynn County Board of Commissioners.'
  },
  {
    yt: 'Tdw_ZekMJxU',
    title: 'City Council Meeting | August 4, 2026',
    org: 'City of Columbia, SC',
    city: 'Columbia', county: 'Richland County', state: 'South Carolina', sc: 'SC',
    tier: 'md', pop: '~140,000',
    body: 'City Council', date: '2026-08-04', dur: 9600,
    topics: ['housing', 'safety'],
    blurb: 'Council takes up regular business ahead of the fall calendar.'
  },
  {
    yt: 'd7vEXdXStEM',
    title: 'City Council Meeting | July 21, 2026',
    org: 'City of Columbia, SC',
    city: 'Columbia', county: 'Richland County', state: 'South Carolina', sc: 'SC',
    tier: 'md', pop: '~140,000',
    body: 'City Council', date: '2026-07-21', dur: 9000,
    topics: ['budget', 'gov'],
    blurb: 'Mid-summer regular session of the Columbia City Council.'
  },
  {
    yt: 'nDl1J61mjlc',
    title: 'County Commission Meeting 07/16/2026',
    org: 'Glynn County, Georgia',
    city: 'Brunswick', county: 'Glynn County', state: 'Georgia', sc: 'GA',
    tier: 'md', pop: '~85,000',
    body: 'County Commission', date: '2026-07-16', dur: 3759,
    topics: ['housing', 'water'],
    blurb: 'The commission convenes for its mid-July meeting.'
  },
  {
    yt: 'WoWtBLUsW1s',
    title: 'City Council Meeting - June 23, 2026',
    org: 'City of Lubbock',
    city: 'Lubbock', county: 'Lubbock County', state: 'Texas', sc: 'TX',
    tier: 'lg', pop: '~265,000',
    body: 'City Council', date: '2026-06-23', dur: 3273,
    topics: ['gov', 'budget'],
    blurb: 'Council opens in regular session before recessing into executive session.'
  },
  {
    yt: 'bkL_FBjQp7E',
    title: 'Planning Commission Hearing 6/18/2026',
    org: 'El Paso County, Colorado',
    city: 'Colorado Springs', county: 'El Paso County', state: 'Colorado', sc: 'CO',
    tier: 'xl', pop: '~730,000',
    body: 'Planning & Zoning', date: '2026-06-18', dur: 22761,
    topics: ['housing', 'infra'],
    blurb: 'Marathon rezoning docket, including statutory notice requirements for map amendments.'
  },
  {
    yt: '1gRr-WKyRLs',
    title: 'Phoenix City Council Formal Meeting - June 17, 2026',
    org: 'City of Phoenix',
    city: 'Phoenix', county: 'Maricopa County', state: 'Arizona', sc: 'AZ',
    tier: 'xl', pop: '~1,650,000',
    body: 'City Council', date: '2026-06-17', dur: 12566,
    topics: ['housing', 'water', 'safety'],
    blurb: 'Formal meeting from the City Council Chambers at 200 W. Jefferson St.'
  },
  {
    yt: 'rm6mZtPTjQo',
    title: 'City Council Meeting - June 15, 2026',
    org: 'City of West Des Moines, Iowa',
    city: 'West Des Moines', county: 'Polk County', state: 'Iowa', sc: 'IA',
    tier: 'md', pop: '~68,000',
    body: 'City Council', date: '2026-06-15', dur: 10438,
    topics: ['infra', 'parks'],
    blurb: 'Regular session of the West Des Moines City Council.'
  },
  {
    yt: 'WZnxklQ4GB8',
    title: 'City Council Meeting - July 22, 2026',
    org: 'Cape TV',
    city: 'Cape Coral', county: 'Lee County', state: 'Florida', sc: 'FL',
    tier: 'lg', pop: '~225,000',
    body: 'City Council', date: '2026-07-22', dur: 14742,
    topics: ['water', 'housing', 'infra'],
    blurb: 'Four-hour regular council meeting carried by the city’s government access channel.'
  },
  {
    yt: 'SpbyWGbn2OI',
    title: 'City Council Meeting - April 1, 2026',
    org: 'Cape TV',
    city: 'Cape Coral', county: 'Lee County', state: 'Florida', sc: 'FL',
    tier: 'lg', pop: '~225,000',
    body: 'City Council', date: '2026-04-01', dur: 7473,
    topics: ['budget', 'parks'],
    blurb: 'Spring council session from Cape Coral City Hall.'
  },
  {
    yt: 'rKGU6F_h-Sg',
    title: 'School Board Meeting 2026-06-08',
    org: 'Indiana Area School District',
    city: 'Indiana', county: 'Indiana County', state: 'Pennsylvania', sc: 'PA',
    tier: 'sm', pop: '~13,000',
    body: 'School Board', date: '2026-06-08', dur: 5651,
    topics: ['schools', 'budget'],
    blurb: 'Regular voting meeting of the Indiana Area school board.'
  },
  {
    yt: 'qEKXTZiS5LI',
    title: 'Phoenix City Council Formal Meeting - May 20, 2026',
    org: 'City of Phoenix',
    city: 'Phoenix', county: 'Maricopa County', state: 'Arizona', sc: 'AZ',
    tier: 'xl', pop: '~1,650,000',
    body: 'City Council', date: '2026-05-20', dur: 5655,
    topics: ['budget', 'safety'],
    blurb: 'Formal council session open to citizen attendance and participation.'
  },
  {
    yt: 'YFScaFCmAp4',
    title: 'City Council Meeting - May 19, 2026',
    org: 'City of Shelton, WA',
    city: 'Shelton', county: 'Mason County', state: 'Washington', sc: 'WA',
    tier: 'sm', pop: '~11,000',
    body: 'City Council', date: '2026-05-19', dur: 12036,
    topics: ['water', 'infra'],
    blurb: 'Long-form council meeting from the Shelton civic chambers.'
  },
  {
    yt: 'zL6uMOy_-7M',
    title: 'City Council Meeting | May 19, 2026',
    org: 'City of Columbia, SC',
    city: 'Columbia', county: 'Richland County', state: 'South Carolina', sc: 'SC',
    tier: 'md', pop: '~140,000',
    body: 'City Council', date: '2026-05-19', dur: 8700,
    topics: ['gov', 'parks'],
    blurb: 'Spring session of the Columbia City Council.'
  },
  {
    yt: 'VALMzGNPWIw',
    title: 'City Council Meeting May 5, 2026',
    org: 'City of Corpus Christi',
    city: 'Corpus Christi', county: 'Nueces County', state: 'Texas', sc: 'TX',
    tier: 'lg', pop: '~317,000',
    body: 'City Council', date: '2026-05-05', dur: 23975,
    topics: ['water', 'budget', 'infra'],
    blurb: 'Nearly seven hours of business, including authorizing staff to negotiate with a regional water group.'
  },
  {
    yt: 'wriZ1C-1Rg8',
    title: 'City Council Formal Meeting - April 22, 2026',
    org: 'City of Phoenix',
    city: 'Phoenix', county: 'Maricopa County', state: 'Arizona', sc: 'AZ',
    tier: 'xl', pop: '~1,650,000',
    body: 'City Council', date: '2026-04-22', dur: 7430,
    topics: ['housing', 'infra'],
    blurb: 'Formal meeting of the Phoenix City Council.'
  },
  {
    yt: 'jYtQ1ZGHZiI',
    title: 'City Council Meeting April 21, 2026 (Full Meeting)',
    org: 'City of San Clemente',
    city: 'San Clemente', county: 'Orange County', state: 'California', sc: 'CA',
    tier: 'md', pop: '~63,000',
    body: 'City Council', date: '2026-04-21', dur: 21455,
    topics: ['housing', 'parks', 'water'],
    blurb: 'Complete recording of the San Clemente City Council, running just under six hours.'
  },
  {
    yt: 'IdxNJ0vfMo4',
    title: 'City Council Meeting - 04-13-2026',
    org: 'City of Texarkana, Texas',
    city: 'Texarkana', county: 'Bowie County', state: 'Texas', sc: 'TX',
    tier: 'sm', pop: '~36,000',
    body: 'City Council', date: '2026-04-13', dur: 4712,
    topics: ['safety', 'infra'],
    blurb: 'Regular meeting of the Texarkana, Texas City Council.'
  },
  {
    yt: 's7Mt5KGkG_o',
    title: 'School Board Meeting - 4/16/26',
    org: 'SYCSD Warrior TV',
    city: 'Southern York County', county: 'York County', state: 'Pennsylvania', sc: 'PA',
    tier: 'sm', pop: '~24,000',
    body: 'School Board', date: '2026-04-16', dur: 17641,
    topics: ['schools', 'budget'],
    blurb: 'Nearly five hours of board business beginning with approval of the agenda.'
  },
  {
    yt: 'gyKa9zr0hi4',
    title: 'School Board Meeting 2026-04-13',
    org: 'Indiana Area School District',
    city: 'Indiana', county: 'Indiana County', state: 'Pennsylvania', sc: 'PA',
    tier: 'sm', pop: '~13,000',
    body: 'School Board', date: '2026-04-13', dur: 2608,
    topics: ['schools'],
    blurb: 'Brisk April meeting of the Indiana Area School Board.'
  },
  {
    yt: 'Dav4wglTJdA',
    title: 'Select Board Meeting March 30, 2026',
    org: 'Town of Southwick, Massachusetts',
    city: 'Southwick', county: 'Hampden County', state: 'Massachusetts', sc: 'MA',
    tier: 'xs', pop: '~9,700',
    body: 'Select Board', date: '2026-03-30', dur: 6900,
    topics: ['housing', 'gov'],
    blurb: 'Select Board convenes at 6 p.m. in the land use hearing room.'
  },
  {
    yt: 'G3qQVgquK_s',
    title: 'City Council Meeting: March 23, 2026',
    org: 'City of Baytown, TX',
    city: 'Baytown', county: 'Harris County', state: 'Texas', sc: 'TX',
    tier: 'md', pop: '~83,000',
    body: 'City Council', date: '2026-03-23', dur: 4568,
    topics: ['safety', 'budget'],
    blurb: 'Council called to order at 6:30 p.m. in Council Chambers, City Hall.'
  },
  {
    yt: 'PbDwQq1x1v0',
    title: 'Select Board - 3-3-2026',
    org: 'Town of Yarmouth',
    city: 'Yarmouth', county: 'Barnstable County', state: 'Massachusetts', sc: 'MA',
    tier: 'sm', pop: '~25,000',
    body: 'Select Board', date: '2026-03-03', dur: 8100,
    topics: ['parks', 'water'],
    blurb: 'Cape Cod select board meeting, opened with a welcome from the chair.'
  },
  {
    yt: 'qMVnRPIlHF0',
    title: 'Zoning Commission Public Hearing - February 26, 2026',
    org: 'Bonner County Planning',
    city: 'Sandpoint', county: 'Bonner County', state: 'Idaho', sc: 'ID',
    tier: 'md', pop: '~52,000',
    body: 'Planning & Zoning', date: '2026-02-26', dur: 17223,
    topics: ['housing', 'gov'],
    blurb: 'Public hearing on county zoning business, streamed for repeated viewing.'
  },
  {
    yt: '_faPkxzAW2Y',
    title: 'County Commission Meeting 02/19/2026',
    org: 'Glynn County, Georgia',
    city: 'Brunswick', county: 'Glynn County', state: 'Georgia', sc: 'GA',
    tier: 'md', pop: '~85,000',
    body: 'County Commission', date: '2026-02-19', dur: 9479,
    topics: ['budget', 'infra'],
    blurb: 'Winter session of the Glynn County Board of Commissioners.'
  },
  {
    yt: 'x2rqs0N4bG0',
    title: 'Flint City Council Meeting with Engagement — Feb. 4, 2026',
    org: 'SpectacleTV-Flint',
    city: 'Flint', county: 'Genesee County', state: 'Michigan', sc: 'MI',
    tier: 'md', pop: '~80,000',
    body: 'City Council', date: '2026-02-04', dur: 9000,
    topics: ['water', 'safety', 'gov'],
    blurb: 'Independent civic channel carrying Flint council meetings, town halls and community voices.'
  },
  {
    yt: 'yE8m7bQZ2hg',
    title: 'Phoenix City Council Formal Meeting - February 4, 2026',
    org: 'City of Phoenix',
    city: 'Phoenix', county: 'Maricopa County', state: 'Arizona', sc: 'AZ',
    tier: 'xl', pop: '~1,650,000',
    body: 'City Council', date: '2026-02-04', dur: 8400,
    topics: ['budget', 'housing'],
    blurb: 'Formal council meeting in the Phoenix City Council Chambers.'
  },
  {
    yt: 'Qf2eLhycgQQ',
    title: 'School Board Meeting - February 23, 2026',
    org: 'JSD Media — Jenkintown School District',
    city: 'Jenkintown', county: 'Montgomery County', state: 'Pennsylvania', sc: 'PA',
    tier: 'xs', pop: '~4,500',
    body: 'School Board', date: '2026-02-23', dur: 4787,
    topics: ['schools', 'gov'],
    blurb: 'Business meeting of the Jenkintown School District board.'
  }
];

/* Upcoming schedule — illustrative sample programming grid for this prototype. */
const UPCOMING = [
  { time: 'Today · 6:00 PM ET', title: 'City Council Regular Session', place: 'Palm Bay, FL', body: 'City Council', live: true },
  { time: 'Today · 7:30 PM ET', title: 'Select Board Meeting', place: 'Chelmsford, MA', body: 'Select Board', live: true },
  { time: 'Mon · 5:30 PM MT', title: 'Planning Commission Hearing', place: 'El Paso County, CO', body: 'Planning & Zoning', live: false },
  { time: 'Tue · 10:00 AM MT', title: 'City Council Formal Meeting', place: 'Phoenix, AZ', body: 'City Council', live: false },
  { time: 'Tue · 6:00 PM ET', title: 'Board of Commissioners', place: 'Glynn County, GA', body: 'County Commission', live: false },
  { time: 'Wed · 7:00 PM ET', title: 'School Board Voting Meeting', place: 'Indiana Area SD, PA', body: 'School Board', live: false },
  { time: 'Thu · 6:00 PM PT', title: 'City Council Meeting', place: 'Shelton, WA', body: 'City Council', live: false }
];
