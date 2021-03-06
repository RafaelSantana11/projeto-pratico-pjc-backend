const { Artist, MusicalGroup, Album, AlbumMedia, sequelize } = require("../models");
const configPagination = require("../config/pagination.json");
const Sequelize = require("sequelize");
const Op = Sequelize.Op;

//configurações do min.io client
const Minio = require('minio');
const minioConfig = require("../config/minioConfig.json");

const client = new Minio.Client({
  endPoint: minioConfig.ENDPOINT,
  accessKey: minioConfig.ACCESS_KEY_ID,
  secretKey: minioConfig.ACCESS_KEY_SECRET
});

/*********** CONTROLLERS DE ALBUM ************/

exports.getAll = async function (req, res) {
  try {
    //verifica se foi enviado a quantidade de resultados por página desejada, se não, pega da config do servidor
    const resultsPerPage = req.query.resultsPerPage
      ? parseInt(req.query.resultsPerPage)
      : configPagination.resultsPerpage;

    //verifica se foi enviado o número da página desejada (via query)
    const page = !req.query.currentPage ? 1 : parseInt(req.query.currentPage);

    //calcula o offset para realizar a paginação
    const offset = page === 1 ? 0 : (page - 1) * resultsPerPage;

    const where = {};

    //vizualisa os filtros desejados e adiciona-is no objeto where para filtragem
    if (req.query.name) where.name = { [Op.like]: `%${req.query.name}%` }; //consulta pelo nome do cantor

    if (req.query.artistName) where['$Artist.name$'] = { [Op.like]: `%${req.query.artistName}%` }; //pelo nome do album

    //realiza a busca paginada incluindo o objeto where com os filtros, ordendando por ordem alfabética
    const albums =
      await Album.findAndCountAll({
        where,
        offset: offset,
        limit: resultsPerPage,
        order: [["id", "ASC"]],
        attributes: { exclude: ["createdAt", "updatedAt"] },
        distinct: true,
        include: [ //inclui na busca os dados de cada modelo relacionado com o artista
          {
            model: Artist,
            attributes: { exclude: ["createdAt", "updatedAt"] },
            include: [
              {
                model: MusicalGroup,
                attributes: { exclude: ["createdAt", "updatedAt"] },
              },
            ]
          },
        ]
      })

    //retorna os dados em formato json
    res.json(albums);
  } catch (error) {
    console.log(error);
    res.status(500).json({});
  }
};

exports.getOne = async function (req, res) {
  try {
    const albumId = req.params.id;

    const album = JSON.parse(
      JSON.stringify(
        await Album.findOne({
          where: { id: albumId },
          attributes: { exclude: ["createdAt", "updatedAt"] },
          include: [
            {
              model: AlbumMedia,
              attributes: { exclude: ["createdAt", "updatedAt"] },
            }
          ]
        })
      )
    );

    res.json(album);
  } catch (error) {
    console.log(error);
    res.status(500).json(error);
  }
};

exports.create = async function (req, res) {
  const t = await sequelize.transaction(); //inicia a transaction, para que se alguma operação der errado, reverta o que tiver sido feito

  try {
    const files = req.files;

    //insere os dados enviados pelo corpo da requisição na tabela dos albuns
    const createdAlbum = await Album.create(req.body, { transaction: t });

    //verifica se existe o bucket, e se nao exixtir, cria
    await verifyIfBucketExists();

    //com a certeza da existência do bucket, armazena os arquivos
    await insertAlbumFiles({ files, albumId: createdAlbum.id, t });

    await t.commit();

    res.json(createdAlbum);
  } catch (error) {
    console.log(error);

    await t.rollback();

    res.status(500).json({});
  }
};

exports.update = async function (req, res) {
  const t = await sequelize.transaction();

  try {

    const albumId = req.params.id;

    const files = req.files;

    //atualiza o artista cujo id foi informado pela rota, substituindo os dados pelos enviados no corpo da requisição
    const updatedData = await Album.update(req.body, {
      where: { id: albumId },
      transaction: t,
    });

    //chama a função auxiliar que insere os arquivos
    await insertAlbumFiles({ files, albumId, t });

    await t.commit();

    res.json(updatedData);
  } catch (error) {
    console.log(error);

    await t.rollback();

    res.status(500).json({});
  }
};

exports.delete = async function (req, res) {
  const t = await sequelize.transaction();

  try {

    const albumId = req.params.id;

    //chama a função auxiliar que remove os arquivos
    await deleteAlbumMedia({ albumId, t });

    //deleta o artista cujo id foi enviado como parâmetro da rota
    await Album.destroy({
      where: { id: albumId },
      transaction: t,
    });

    await t.commit();

    res.send(true);
  } catch (error) {
    console.log(error);

    await t.rollback();

    res.status(500).json({});
  }
};

exports.deleteAlbumFiles = async function (req, res) {
  const t = await sequelize.transaction();

  try {

    const albumId = req.params.id

    await deleteAlbumMedia({ albumId, t });

    await t.commit();

    res.send(true);
  } catch (error) {
    console.log(error)
    await t.rollback();
    res.status(500).json({});
  }
};


/********* FUNÇÕES AUXILIARES *********/

async function insertAlbumFiles({ files, albumId, t }) {
  const filePromises = []; //array de promises

  //para cada arquivo
  for (const file of files) {
    //salva os objetos no minio
    client.putObject(minioConfig.BUCKET,
      file.originalname,
      file.buffer,
      function (err, etag) {
        return console.log(err, etag) // err should be null
      })

    //gera uma url para acessá-lo
    let presignedUrl = await client.presignedGetObject(
      minioConfig.BUCKET,
      file.originalname,
      1000)

    //insere os arquivos de midia na tabela
    filePromises.push(
      AlbumMedia.create(
        { name: file.originalname, url: presignedUrl, AlbumId: albumId },
        { transaction: t }
      )
    );
  }

  await Promise.all(filePromises);
}

async function deleteAlbumMedia({ albumId, t }) {
  //busca os registros de arquivos para aquele album na tabela de Album Media
  const albumFiles = JSON.parse(
    JSON.stringify(
      await AlbumMedia.findAll({
        where: { AlbumId: albumId },
        transaction: t,
      })
    )
  )

  //deleta os registros de arquivos do album na tabela de Album Media
  await AlbumMedia.destroy({
    where: { AlbumId: albumId },
    transaction: t,
  });

  //para cada arquivo registrado, deleta do bucket no min.io
  for (const file of albumFiles) {
    await client.removeObject(minioConfig.BUCKET, file.name)
  }
}

async function verifyIfBucketExists() {
  //busca os buckets
  const buckets = await client.listBuckets();

  //busca no array de buckets o nome do bucket descrito em minioConfig
  const index = buckets.findIndex(
    (item) => item.name == minioConfig.BUCKET
  );

  //quando não é encontrado, a função findIndex retorna -1
  if (index === -1) await client.makeBucket(minioConfig.BUCKET);
}
