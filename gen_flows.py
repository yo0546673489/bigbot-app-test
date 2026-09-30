# Generates flows/02..05 (the full screen sweep). Run: python gen_flows.py
import io
L=[]
def a(x): L.append(x)
def head(name):
    L.clear(); a(f'''appId: com.bigbotdrivers.app\nname: {name}\n---\n- launchApp\n- waitForAnimationToEnd:\n    timeout: 10000
- tapOn:
    text: "אחר כך"
    optional: true''')
def save(p): io.open(p,'w',encoding='utf-8',newline='\n').write('\n'.join(L)+'\n')
def shot(n): a(f'- takeScreenshot: shots/{n}')
def wait(ms=2500): a(f'- extendedWaitUntil:\n    visible: "__w__"\n    timeout: {ms}\n    optional: true')
def tap(t,idx=None):
    s=f'- tapOn:\n    text: "{t}"\n'
    if idx is not None: s+=f'    index: {idx}\n'
    a(s+'    optional: true\n- waitForAnimationToEnd')
def scroll_to(t,d='DOWN'): a(f'- scrollUntilVisible:\n    element:\n      text: "{t}"\n    direction: {d}\n    optional: true')
def back():
    a('''- runFlow:
    when:
      platform: iOS
    commands:
      - tapOn:
          text: "(חזרה|סגור)"
          optional: true
- runFlow:
    when:
      platform: Android
    commands:
      - back
- waitForAnimationToEnd''')
def drawer(): tap("בית"); tap("תפריט")

head('02 drawer and tabs')
drawer(); shot('02_01_drawer')
for i,(t,n) in enumerate([("צ'אט","chat"),("חיפוש","search"),("התראות","notifications"),("הגדרות","settings"),("הפרופיל שלי","profile"),("אודות BigBot","about")]):
    drawer(); tap(t); wait(); shot(f'02_{i+2:02d}_{n}'); a('- scroll'); shot(f'02_{i+2:02d}_{n}_b')
    if n in ('profile','about'): back()
for i,(t,n) in enumerate([("בית","home"),("צ'אט","chat"),("חיפוש","search"),("הגדרות","settings")]):
    tap(t); shot(f'02_2{i}_tab_{n}')
save('flows/02_drawer_tabs.yaml')

head('03 settings')
tap("הגדרות"); shot('03_00_settings'); a('- scroll'); shot('03_00_settings_b')
cats=[("נסיעות וסינון","rides"),("תגובות וצ'אט","chat"),("אוטומציה","auto"),("התראות ותצוגה","display"),("שיתוף נסיעות","share"),("מכשירים","devices"),("חשבון ותמיכה","account")]
for i,(t,n) in enumerate(cats):
    scroll_to(f".*{t}.*"); tap(f".*{t}.*"); shot(f'03_{i+1}a_{n}')
    for k in 'bcde': a('- scroll'); shot(f'03_{i+1}{k}_{n}')
    back(); scroll_to(".*נסיעות וסינון.*",'UP')
scroll_to(".*וואטסאפ.*",'UP'); tap(".*חיבור וואטסאפ.*|.*וואטסאפ מחובר.*"); shot('03_8_whatsapp'); back()
save('flows/03_settings.yaml')

head('04 settings deep pages')
deep=[("התראות ותצוגה","עיצוב כרטיסיות","card"),("התראות ותצוגה","רקע האפליקציה","background"),("נסיעות וסינון",".*סינון קבוצות.*","groups"),("נסיעות וסינון",".*מחיר מינימלי.*","minprice"),("חשבון ותמיכה",".*המנוי שלי.*","billing"),("חשבון ותמיכה",".*צ'אט שירות לקוחות.*","support"),("חשבון ותמיכה",".*מחק חשבון.*","delete_dialog_only")]
for i,(c,t,n) in enumerate(deep):
    # fresh start for every page: no Back / scroll-up (on Android those left the app or opened the shade)
    a('''- launchApp:
    stopApp: true
- waitForAnimationToEnd:
    timeout: 8000''')
    tap("אחר כך"); tap("הגדרות"); scroll_to(f".*{c}.*"); tap(f".*{c}.*"); scroll_to(t); tap(t); wait(); shot(f'04_{i+1}_{n}')
    if n not in ('delete_dialog_only','minprice'): a('- scroll'); shot(f'04_{i+1}_{n}_b')
save('flows/04_settings_deep.yaml')

head('05 chat and search')
tap("צ'אט"); wait(); shot('05_01_chat_list')
tap("שיחה חדשה"); tap("050-000-0000"); a('- inputText: "0501234567"'); shot('05_02_new_chat_KEYBOARD')
tap("פתח צ'אט"); wait(3000); shot('05_03_conversation')
tap(".*הקלד.*|.*הודעה.*"); a('- inputText: "בדיקה"'); shot('05_04_composer_KEYBOARD')
a('- eraseText: 10'); tap("עוד"); shot('05_05_more_menu'); tap("ערכת נושא לצ'אט"); wait(2000); shot('05_06_theme'); back(); back(); back()
tap("חיפוש"); wait(); shot('05_10_search')
tap("הוסף מסלול חדש"); tap(".*אזור יציאה.*"); a('- inputText: "תא"'); shot('05_11_search_add_KEYBOARD'); back()
a('- scroll'); shot('05_12_search_scrolled')
tap("הגדרות"); scroll_to(".*חשבון ותמיכה.*"); tap(".*חשבון ותמיכה.*"); scroll_to("החלף תפקיד"); tap("החלף תפקיד"); wait(3000); shot('05_20_role_chooser')
save('flows/05_chat_search.yaml')
