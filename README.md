# IA locale pour Paseo

Un agent de code qui tourne **sur ta machine**, sans abonnement ni cloud : un plugin pour
[Paseo](https://paseo.sh) qui installe et règle tout seul le moteur (llama.cpp), l'agent
(Oh My Pi) et le modèle adapté à ta carte graphique.

> Version bêta. Ce dépôt ne contient que les installateurs.

## Télécharger

Va dans **[Releases](https://github.com/Capetlevrai/ia-locale/releases)** et prends le fichier
de ton système.

| Système | Fichier | Installation |
|---|---|---|
| Windows 10/11 | `CapetLocal-Setup.exe` | double-clic |
| Linux (x86_64) | `CapetLocal-Setup.sh` | dans un terminal : `bash ~/Downloads/CapetLocal-Setup.sh` |
| Mac à puce Apple (M1+) | `CapetLocal-Setup.sh` | dans le Terminal : `bash ~/Downloads/CapetLocal-Setup.sh` |

L'installateur met tout en place (Paseo, l'agent, le plugin, le moteur et le modèle conseillé),
puis ajoute l'agent « IA locale » à Paseo. Il peut être relancé sans risque. Aucun mot de passe
administrateur sous Linux et Mac. À la fin : ouvre Paseo, crée un agent et choisis « IA locale ».

Windows peut afficher « Windows a protégé votre ordinateur » : clique sur « Informations
complémentaires » puis « Exécuter quand même ».

## Ce qu'il faut

- Une carte **NVIDIA** de 10 Go ou plus (pilote récent), ou un **Mac à puce Apple**
  (24 Go de mémoire ou plus conseillés).
- Cartes AMD et Intel, et Mac : prise en charge **expérimentale**.
- 16 Go de RAM minimum, 32 Go conseillés ; 15 à 20 Go d'espace disque pour le modèle.

| Système | Carte | État |
|---|---|---|
| Windows | NVIDIA | testé |
| Linux | NVIDIA | testé (Ubuntu 24.04) |
| Windows, Linux | AMD, Intel | expérimental |
| macOS | Apple M1 et plus récents | expérimental, à tester |

Détails, modèles proposés et dépannage : [LISEZMOI.txt](LISEZMOI.txt).

## Un souci ?

Ouvre une [issue](https://github.com/Capetlevrai/ia-locale/issues) avec ton système, ta carte
graphique et le fichier `CapetLocal/logs/llama-server.log` (dans `%LOCALAPPDATA%` sous
Windows, `~/.local/share` sous Linux, `~/Library/Application Support` sur Mac).
