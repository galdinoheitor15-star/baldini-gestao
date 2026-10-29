# Gestão Baldini

Painel da equipe: **https://galdinoheitor15-star.github.io/baldini-gestao/**

Ligado ao site de pedidos **https://galdinoheitor15-star.github.io/baldini-burguer/** (repositório `baldini-burguer`):
- o site grava os pedidos no banco e a gestão lê de lá, ao vivo;
- a gestão usa o cardápio e as fotos do próprio site (mudou o cardápio lá, muda aqui);
- o rodapé do site tem o link "Área da equipe" para cá.

`firebase-config.js` precisa ser **igual nos dois repositórios**.

## O que já funciona sem configurar nada (modo demonstração)
- Pedidos aparecem **ao vivo** enquanto o cliente monta a sacola ("Montando agora") e viram "Novo" quando ele envia.
- Quadro de pedidos: Novo → Em preparo → Pronto → Saiu p/ entrega → Concluído, com som de aviso, comanda para imprimir e botão "Avisar cliente" no WhatsApp.
- Lançar pedido do balcão/telefone com o mesmo cardápio do site.
- Caixa: quanto entrou no dia, na semana e no mês, com gráfico por forma de pagamento (Pix, crédito, débito, dinheiro). A antiga aba Lucro está desligada (para religar, ponha "lucro" na lista do dono em `CARGOS`, no `baldini-core.js`).
- Bot "🍔 Ajuda" no site: responde horário, endereço, pagamento e pontos, acha o lanche pelo nome e mostra o status do pedido.
- Testes automáticos: abra **/tests/index.html**.

No modo demonstração os dados ficam só no navegador (o site e a gestão se enxergam quando abertos no mesmo navegador). Para a loja usar de verdade, faça o passo 1.

## Cargos: quem vê o quê
| Cargo | Abas |
|---|---|
| 🧑‍🍳 **Funcionário** | Mesas, comandas e **retiradas** (abrir, lançar, trocar/juntar, cancelar, tirar item, pedir, **fechar e reabrir a conta**) e Pedidos |
| 🧑‍💼 **Gerente** | Caixa (fechar conta + gráfico de pizza por Pix, crédito, débito e dinheiro), Estoque, **Cardápio** (preços e produtos novos), Equipe (cria e tira o acesso de **funcionários**), Mesas e comandas, Pedidos e Lançar pedido |
| 👑 **Dono** | Tudo, incluindo Nota fiscal, Equipe e Configurações |

- Na aba **👥 Equipe** o dono cria o acesso com **usuário e senha** (a pessoa entra em "Entrar com usuário e senha"), ou libera quem entrou com Google colando o código que aparece na tela da pessoa.
- Para criar acesso com usuário e senha, o login por **E-mail/senha** precisa estar ativo no Firebase (Authentication → Método de login).
- Quem já estava na equipe antes dos cargos (sem o campo `cargo`) é tratado como **dono**. Ajuste o cargo de cada um na aba Equipe.
- O dono tem o seletor **"Ver como"** no topo para conferir a tela de cada cargo.
- Para mudar quais abas cada cargo vê, edite a lista `CARGOS` em `baldini-core.js`.
- **Depois de atualizar, publique de novo o `firestore.rules`** (passo 1.5): as regras novas é que deixam o dono liberar pessoas e impedem gerente/funcionário de mudar configurações, despesas e apagar pedidos.

## Cardápio (preços e produtos novos)
Na aba **🍔 Cardápio**, dono e gerente mudam preços (inclusive das opções, como tamanho da batata e sabor do refri), escondem produtos e adicionam produtos novos. Fica salvo no banco (`config/cardapio`) e vale para o site e para a gestão na hora: o site lê os ajustes pelo arquivo `menu-ajustes.js` do repositório `baldini-burguer`. Produto novo entra sem foto e sem adicionais.

## Retirada na loja
Em **Mesas e comandas → 🥡 Nova retirada**: para quem pediu no balcão, no iFood ou por telefone e vai buscar na loja (sem mesa). Ao fechar a conta de uma retirada do iFood, aparece a opção "Pago no iFood".

## Estoque
Na aba Estoque, digite a quantidade de cada produto e o mínimo. Toda venda (site, balcão ou mesa) dá baixa sozinha e pedido cancelado devolve. Produtos em falta aparecem marcados na hora de lançar o pedido.

## 1. Firebase (banco de dados, obrigatório)
1. Acesse https://console.firebase.google.com e crie o projeto "baldini-burguer".
2. **Firestore Database** → Criar banco → região `southamerica-east1`.
3. **Authentication** → Método de login → ative **E-mail/senha**. Em *Users*, adicione o e-mail e a senha de cada pessoa da equipe.
4. Copie o **UID** do dono. No Firestore, crie a coleção `equipe` e, dentro dela, um documento com esse UID como ID, com os campos `nome` e `cargo` = `dono`. As outras pessoas o dono libera depois, pela aba **Equipe** da gestão.
5. Firestore → **Regras** → cole o conteúdo de `firestore.rules` → Publicar.
6. Configurações do projeto → Seus apps → **Web** → copie os dados para `firebase-config.js` **neste repositório e no `baldini-burguer`**.
7. Authentication → Configurações → **Domínios autorizados** → adicione `galdinoheitor15-star.github.io`.

## 2. Maquininha InfinitePay (laranjinha)
- Em **Configurações** na gestão, coloque sua **InfiniteTag** (sem o $).
- No pedido, a gestão mostra o valor em destaque para digitar na maquininha e você marca Pix, Débito, Crédito ou Dinheiro.
- O botão **Gerar link InfinitePay** cria um link de Pix ou cartão (até 12x) para mandar ao cliente. Marcando "Pagar online agora", essa opção também aparece no site.
- A maquininha física não tem integração automática com sites. O valor é digitado nela, e a gestão registra a forma de pagamento.
- Ajuste as taxas (%) de cada forma de pagamento em Configurações para o lucro sair certo.

## 3. Nota fiscal (NFC-e)
1. Crie uma conta num emissor com API. O código está pronto para a **Focus NFe** (https://focusnfe.com.br), que pede o certificado A1 e o CSC da SEFAZ-PE.
2. Confira com o contador o **NCM** e o **CSOSN** dos lanches e preencha em Configurações.
3. Publique as funções (passo 5) com o token: `firebase functions:secrets:set FOCUS_TOKEN`.
4. Comece em homologação (testes). Quando estiver certo, troque `FOCUS_AMBIENTE` para `producao`.

## 4. iFood (pedidos e localização dos entregadores)
1. No Portal do Desenvolvedor iFood (https://developer.ifood.com.br), crie um aplicativo centralizado e vincule a loja.
2. Guarde as credenciais: `firebase functions:secrets:set IFOOD_CLIENT_ID` e `firebase functions:secrets:set IFOOD_CLIENT_SECRET`.
3. Ligue "Integração iFood" em Configurações. A cada minuto, os pedidos do iFood entram no quadro e a posição do entregador aparece no mapa da aba **Entregadores**.
4. A posição só vem nas entregas feitas por entregadores do iFood. Confira no portal se o seu plano libera o rastreio.

## 5. Publicar as funções do servidor (nota fiscal, webhook, iFood)
Precisa do plano **Blaze** do Firebase (paga pelo uso e tem cota grátis). Com o Node.js instalado:
```
npm install -g firebase-tools
firebase login
firebase use --add
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules
```
Depois, cole a URL da função `infinitepayWebhook` em Configurações → URL do webhook.

## 6. Testes "para não cair"
- `.github/workflows/testes.yml` roda todos os testes a cada alteração enviada ao GitHub.
- `.github/workflows/site-no-ar.yml` confere a cada 15 minutos se o site e a gestão estão no ar. Se cair, o GitHub manda e-mail.
- Se o banco cair, o site continua mandando o pedido pelo WhatsApp, como antes.
- A aba **Sistema** da gestão mostra a saúde de tudo.
